import type { Env } from "../env";
import { readProvider, type Connection } from "../durable-objects/garmin-auth";
import {
  mapActivity,
  mapHealth,
  mapTraining,
  object,
  text,
  number,
} from "../providers/garmin/mapper";
import { sha256 } from "../lib/crypto";
import { ServiceError, safeCode } from "../lib/errors";
import { extractFit, parseFit } from "./fit";
import type { ProviderOperation } from "../providers/garmin/client";

export const dateInZone = (zone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(new Date());
export function daysBetween(start: string, end: string): string[] {
  const days: string[] = [];
  for (
    let time = Date.parse(start);
    time <= Date.parse(end);
    time += 86_400_000
  ) {
    if (days.length >= 366) throw new ServiceError("DATE_RANGE_TOO_LARGE");
    days.push(new Date(time).toISOString().slice(0, 10));
  }
  return days;
}
export async function startSync(
  env: Env,
  connection: Connection,
  stream: string,
  start: string,
  end: string,
  mode = "incremental",
  initial = false,
) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  // Partial unique index makes the stream lock authoritative across Cron/Web calls.
  try {
    await env.DB.prepare(
      "INSERT INTO sync_runs (id,connection_id,stream,mode,start_date,end_date,status,started_at,updated_at,workflow_id,initial_sync) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        id,
        connection.id,
        stream,
        mode,
        start,
        end,
        "queued",
        now,
        now,
        id,
        Number(initial),
      )
      .run();
  } catch (error) {
    const active = await env.DB.prepare(
      "SELECT id FROM sync_runs WHERE connection_id=? AND stream=? AND status IN ('queued','running')",
    )
      .bind(connection.id, stream)
      .first<{ id: string }>();
    if (active) return { id: active.id, existing: true };
    throw error;
  }
  try {
    await env.SYNC_WORKFLOW.create({ id, params: { runId: id } });
  } catch (error) {
    await env.DB.prepare(
      "UPDATE sync_runs SET status=?,error_code=?,finished_at=? WHERE id=?",
    )
      .bind("failed", "WORKFLOW_START_FAILED", new Date().toISOString(), id)
      .run();
    throw error;
  }
  return { id, existing: false };
}

export async function syncActivityPage(
  env: Env,
  row: Connection,
  start: string,
  end: string,
  offset: number,
  archive: boolean,
) {
  const raw = await readProvider<unknown>(env, row, "activities", {
    date: start,
    endDate: end,
    start: offset,
    limit: 50,
  });
  if (!Array.isArray(raw))
    throw new ServiceError("INVALID_UPSTREAM_RESPONSE", 502);
  let count = 0;
  for (const value of raw) {
    const activity = mapActivity(value, env.APP_TIMEZONE);
    if (!activity) throw new ServiceError("INVALID_ACTIVITY_RESPONSE", 502);
    const id = `${row.id}_${activity.external_activity_id}`;
    const hash = await sha256(JSON.stringify(activity));
    const now = new Date().toISOString();
    const previous = await env.DB.prepare(
      "SELECT source_hash FROM activities WHERE id=? AND connection_id=?",
    )
      .bind(id, row.id)
      .first<{ source_hash: string }>();
    const fields = Object.keys(activity);
    const values = Object.values(activity);
    await env.DB.prepare(
      `INSERT INTO activities (id,connection_id,${fields.join(",")},synced_at,source_hash) VALUES (${Array(
        fields.length + 4,
      )
        .fill("?")
        .join(
          ",",
        )}) ON CONFLICT(connection_id,external_activity_id) DO UPDATE SET ${fields
        .filter((field) => field !== "external_activity_id")
        .map((field) => `${field}=excluded.${field}`)
        .join(
          ",",
        )},synced_at=excluded.synced_at,source_hash=excluded.source_hash`,
    )
      .bind(id, row.id, ...values, now, hash)
      .run();
    if (archive) {
      await env.DB.prepare(
        "INSERT INTO activity_files (id,activity_id,status) VALUES (?,?,'pending') ON CONFLICT(activity_id,format) DO NOTHING",
      )
        .bind(`${id}_fit`, id)
        .run();
      if (previous && previous.source_hash !== hash)
        await env.DB.prepare(
          "UPDATE activity_files SET status='pending' WHERE activity_id=?",
        )
          .bind(id)
          .run();
    }
    count++;
  }
  return { count, hasMore: raw.length === 50 };
}

export async function archiveActivity(
  env: Env,
  row: Connection,
  activityId: string,
): Promise<void> {
  const activity = await env.DB.prepare(
    "SELECT external_activity_id FROM activities WHERE id=? AND connection_id=?",
  )
    .bind(activityId, row.id)
    .first<{ external_activity_id: string }>();
  if (!activity) throw new ServiceError("NOT_FOUND", 404);
  try {
    const bytes = extractFit(
      await readProvider<Uint8Array<ArrayBuffer>>(env, row, "file", {
        id: activity.external_activity_id,
      }),
    );
    // Validate before advertising a file as ready. Hash is part of the immutable key,
    // so an edited activity never silently changes the old object's identity.
    await parseFit(bytes, 10);
    const hash = await sha256(bytes);
    const key = `health/${row.user_id}/${row.id}/activities/${activity.external_activity_id}/${hash}.fit`;
    await env.FIT_BUCKET.put(key, bytes, {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: { sha256: hash },
    });
    const stored = await env.FIT_BUCKET.head(key);
    if (
      !stored ||
      stored.size !== bytes.length ||
      stored.customMetadata?.sha256 !== hash
    )
      throw new ServiceError("R2_VERIFICATION_FAILED", 502);
    await env.DB.prepare(
      "UPDATE activity_files SET status='ready',r2_key=?,sha256=?,size_bytes=?,error_code=NULL WHERE activity_id=? AND format='fit'",
    )
      .bind(key, hash, bytes.length, activityId)
      .run();
  } catch (error) {
    await env.DB.prepare(
      "UPDATE activity_files SET status='error',error_code=? WHERE activity_id=?",
    )
      .bind(safeCode(error), activityId)
      .run();
    throw error;
  }
}

async function optionalData(
  env: Env,
  row: Connection,
  operation: ProviderOperation,
  date: string,
): Promise<{ data: unknown; status: string }> {
  try {
    return {
      data: await readProvider(env, row, operation, { date }),
      status: "available",
    };
  } catch (error) {
    if (
      error instanceof ServiceError &&
      ["PROVIDER_DATA_UNAVAILABLE", "PROVIDER_BLOCKED"].includes(error.code)
    )
      return {
        data: null,
        status: error.code === "PROVIDER_BLOCKED" ? "forbidden" : "unavailable",
      };
    throw error;
  }
}
async function saveDaily(
  env: Env,
  table: "daily_health" | "training_metrics",
  row: Connection,
  date: string,
  values: Record<string, string | number | null>,
  sources: Record<string, string>,
  fieldSource: Record<string, string>,
) {
  const now = new Date().toISOString();
  const previous = await env.DB.prepare(
    `SELECT availability,fetched_at FROM ${table} WHERE connection_id=? AND local_date=?`,
  )
    .bind(row.id, date)
    .first<{ availability: string; fetched_at: string }>();
  let old: Record<string, { fetchedAt?: string }> = {};
  try {
    old = JSON.parse(previous?.availability || "{}");
  } catch {
    /* Old metadata may be absent. */
  }
  const availability = Object.fromEntries(
    Object.entries(sources).map(([source, status]) => [
      source,
      {
        status,
        fetchedAt:
          status === "available"
            ? now
            : old[source]?.fetchedAt || previous?.fetched_at || null,
      },
    ]),
  );
  const fields = Object.keys(values);
  const hasData = Object.values(sources).some(
    (status) => status === "available",
  );
  await env.DB.prepare(
    `INSERT INTO ${table} (connection_id,local_date,${fields.join(",")},fetched_at,availability) VALUES (${Array(
      fields.length + 4,
    )
      .fill("?")
      .join(
        ",",
      )}) ON CONFLICT(connection_id,local_date) DO UPDATE SET ${fields.map((field) => `${field}=CASE WHEN ? THEN excluded.${field} ELSE ${table}.${field} END`).join(",")},fetched_at=CASE WHEN ? THEN excluded.fetched_at ELSE ${table}.fetched_at END,availability=excluded.availability`,
  )
    .bind(
      row.id,
      date,
      ...Object.values(values),
      now,
      JSON.stringify(availability),
      ...fields.map((field) =>
        Number(sources[fieldSource[field]!] === "available"),
      ),
      Number(hasData),
    )
    .run();
  return {
    count: 1,
    unavailable: Object.values(sources).some(
      (status) => status !== "available",
    ),
  };
}
export async function syncHealthDay(env: Env, row: Connection, date: string) {
  const summary = await optionalData(env, row, "health", date);
  const sleep = await optionalData(env, row, "sleep", date);
  const hrv = await optionalData(env, row, "hrv", date);
  return saveDaily(
    env,
    "daily_health",
    row,
    date,
    mapHealth(summary.data, sleep.data, hrv.data),
    { summary: summary.status, sleep: sleep.status, hrv: hrv.status },
    {
      steps: "summary",
      resting_hr: "summary",
      stress: "summary",
      body_battery: "summary",
      distance_m: "summary",
      sleep_seconds: "sleep",
      sleep_score: "sleep",
      hrv: "hrv",
    },
  );
}
export async function syncTrainingDay(env: Env, row: Connection, date: string) {
  const status = await optionalData(env, row, "training", date);
  const vo2 = await optionalData(env, row, "vo2max", date);
  const readiness = await optionalData(env, row, "readiness", date);
  return saveDaily(
    env,
    "training_metrics",
    row,
    date,
    mapTraining(status.data, vo2.data, readiness.data),
    { status: status.status, vo2: vo2.status, readiness: readiness.status },
    {
      vo2max: "vo2",
      readiness: "readiness",
      training_load: "status",
      training_status: "status",
    },
  );
}
export async function syncDevicesRecords(
  env: Env,
  row: Connection,
  date: string,
) {
  const devices = await optionalData(env, row, "devices", date);
  const records = await optionalData(env, row, "records", date);
  const now = new Date().toISOString();
  for (const raw of Array.isArray(devices.data)
    ? devices.data.slice(0, 100)
    : []) {
    const device = object(raw);
    const id = String(device.deviceId ?? device.unitId ?? "");
    if (!id) continue;
    await env.DB.prepare(
      "INSERT INTO devices VALUES (?,?,?,?) ON CONFLICT(connection_id,external_device_id) DO UPDATE SET model=excluded.model,last_seen_at=excluded.last_seen_at",
    )
      .bind(
        row.id,
        id,
        text(device.productDisplayName || device.deviceTypePk, "Garmin"),
        now,
      )
      .run();
  }
  for (const raw of Array.isArray(records.data)
    ? records.data.slice(0, 200)
    : []) {
    const record = object(raw);
    const id = String(record.id ?? record.personalRecordId ?? "");
    if (!id) continue;
    await env.DB.prepare(
      "INSERT INTO personal_records VALUES (?,?,?,?,?,?,?) ON CONFLICT(connection_id,external_id) DO UPDATE SET value=excluded.value,recorded_at=excluded.recorded_at,fetched_at=excluded.fetched_at",
    )
      .bind(
        row.id,
        id,
        String(record.typeId ?? record.type ?? "other"),
        number(record.value),
        text(record.unit) || null,
        text(record.actStartDateTimeInGMT) || null,
        now,
      )
      .run();
  }
  return { count: 1 };
}
