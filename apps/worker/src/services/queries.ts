import { APP_TIMEZONE } from "../config";
import { z } from "zod";
import type { Env } from "../env";
import type { Connection } from "../durable-objects/garmin-auth";
import type { Activity } from "../providers/garmin/mapper";
import { ServiceError } from "../lib/errors";
import { parseFit } from "./fit";
import { sha256, base64, unbase64 } from "../lib/crypto";
import { dateInZone, daysBetween } from "./sync";

export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (date) =>
      !Number.isNaN(Date.parse(date)) &&
      new Date(date).toISOString().slice(0, 10) === date,
  );
export const rangeSchema = z
  .object({ start: dateSchema, end: dateSchema })
  .refine(
    (range) =>
      range.start <= range.end &&
      Date.parse(range.end) - Date.parse(range.start) <= 365 * 86_400_000,
  );
export async function ownerConnection(
  env: Env,
  userId: string,
  id?: string,
): Promise<Connection | null> {
  const query =
    "SELECT * FROM provider_connections WHERE user_id=?" +
    (id
      ? " AND id=?"
      : " AND external_user_id NOT LIKE 'pending:%' ORDER BY (status='connected') DESC,last_verified_at DESC") +
    " LIMIT 1";
  const row = await env.DB.prepare(query)
    .bind(...(id ? [userId, id] : [userId]))
    .first<Connection>();
  if (id && !row) throw new ServiceError("CONNECTION_NOT_FOUND", 404);
  return row;
}
export async function activityPage(
  env: Env,
  userId: string,
  options: {
    connectionId?: string;
    start?: string;
    end?: string;
    sport?: string;
    search?: string;
    limit?: number;
    cursor?: string;
  },
) {
  const connection = await ownerConnection(env, userId, options.connectionId);
  if (!connection) return { items: [], nextCursor: null, connectionId: null };
  const limit = Math.min(options.limit || 20, 100);
  const clauses = ["a.connection_id=?", "c.user_id=?"];
  const values: (string | number)[] = [connection.id, userId];
  for (const [key, operator, value] of [
    ["a.local_date", ">=", options.start],
    ["a.local_date", "<=", options.end],
    ["a.sport_type", "=", options.sport],
  ] as const)
    if (value) {
      clauses.push(`${key}${operator}?`);
      values.push(value);
    }
  if (options.search) {
    clauses.push("a.name LIKE ? ESCAPE '\\'");
    values.push(`%${options.search.replace(/[\\%_]/g, "\\$&")}%`);
  }
  if (options.cursor) {
    let cursor: { date: string; id: string; context: string };
    try {
      cursor = JSON.parse(
        new TextDecoder().decode(unbase64(options.cursor)),
      ) as typeof cursor;
    } catch {
      throw new ServiceError("INVALID_CURSOR");
    }
    const context = JSON.stringify([
      connection.id,
      options.start || "",
      options.end || "",
      options.sport || "",
      options.search || "",
    ]);
    if (
      cursor.context !== context ||
      typeof cursor.date !== "string" ||
      typeof cursor.id !== "string"
    )
      throw new ServiceError("INVALID_CURSOR");
    clauses.push("(a.start_time_utc<? OR (a.start_time_utc=? AND a.id<?))");
    values.push(cursor.date, cursor.date, cursor.id);
  }
  const results = (
    await env.DB.prepare(
      `SELECT a.* FROM activities a JOIN provider_connections c ON c.id=a.connection_id WHERE ${clauses.join(" AND ")} ORDER BY a.start_time_utc DESC,a.id DESC LIMIT ?`,
    )
      .bind(...values, limit + 1)
      .all<Activity>()
  ).results;
  const hasMore = results.length > limit;
  const items = results.slice(0, limit);
  const last = items.at(-1);
  const context = JSON.stringify([
    connection.id,
    options.start || "",
    options.end || "",
    options.sport || "",
    options.search || "",
  ]);
  return {
    items,
    nextCursor:
      hasMore && last
        ? base64(
            new TextEncoder().encode(
              JSON.stringify({
                date: last.start_time_utc,
                id: last.id,
                context,
              }),
            ),
          )
        : null,
    connectionId: connection.id,
  };
}
export async function getActivity(env: Env, userId: string, id: string) {
  const row = await env.DB.prepare(
    "SELECT a.* FROM activities a JOIN provider_connections c ON c.id=a.connection_id WHERE a.id=? AND c.user_id=?",
  )
    .bind(id, userId)
    .first<Activity>();
  if (!row) throw new ServiceError("ACTIVITY_NOT_FOUND", 404);
  return row;
}
export async function getActivityFile(
  env: Env,
  userId: string,
  id: string,
  fileId?: string,
) {
  await getActivity(env, userId, id);
  const file = await env.DB.prepare(
    "SELECT f.* FROM activity_files f JOIN activities a ON a.id=f.activity_id JOIN provider_connections c ON c.id=a.connection_id WHERE f.activity_id=? AND c.user_id=? AND f.status='ready'" +
      (fileId ? " AND f.id=?" : "") +
      " LIMIT 1",
  )
    .bind(...(fileId ? [id, userId, fileId] : [id, userId]))
    .first<{
      id: string;
      r2_key: string;
      sha256: string;
      size_bytes: number;
    }>();
  if (!file) throw new ServiceError("ACTIVITY_FILE_UNAVAILABLE", 404);
  const object = await env.FIT_BUCKET.get(file.r2_key);
  if (
    !object ||
    object.size !== file.size_bytes ||
    (object.customMetadata?.sha256 !== undefined &&
      object.customMetadata.sha256 !== file.sha256)
  )
    throw new ServiceError("ACTIVITY_FILE_UNAVAILABLE", 404);
  if (
    object.size > Math.min(Number(env.MAX_FIT_BYTES) || 16_777_216, 33_554_432)
  )
    throw new ServiceError("FIT_TOO_LARGE", 413);
  const bytes = new Uint8Array(await object.arrayBuffer());
  if ((await sha256(bytes)) !== file.sha256)
    throw new ServiceError("FIT_INTEGRITY_FAILED", 502);
  return { file, bytes };
}
export async function activityDetails(
  env: Env,
  userId: string,
  id: string,
  maxPoints = 2000,
) {
  const { bytes } = await getActivityFile(env, userId, id);
  return parseFit(bytes, maxPoints);
}
export async function dateRows(
  env: Env,
  userId: string,
  table: "daily_health" | "training_metrics",
  start: string,
  end: string,
  connectionId?: string,
) {
  if (!rangeSchema.safeParse({ start, end }).success)
    throw new ServiceError("INVALID_DATE_RANGE");
  const connection = await ownerConnection(env, userId, connectionId);
  if (!connection)
    return {
      items: [],
      connectionId: null,
      source: "garmin",
      range: { start, end },
    };
  const items = (
    await env.DB.prepare(
      `SELECT d.* FROM ${table} d JOIN provider_connections c ON c.id=d.connection_id WHERE c.user_id=? AND d.connection_id=? AND d.local_date>=? AND d.local_date<=? ORDER BY d.local_date`,
    )
      .bind(userId, connection.id, start, end)
      .all<Record<string, unknown>>()
  ).results;
  const byDate = new Map(items.map((row) => [row.local_date, row]));
  const fields =
    table === "daily_health"
      ? [
          "steps",
          "resting_hr",
          "sleep_seconds",
          "sleep_score",
          "hrv",
          "stress",
          "body_battery",
          "distance_m",
        ]
      : ["vo2max", "readiness", "training_load", "training_status"];
  const complete = daysBetween(start, end).map(
    (date) =>
      byDate.get(date) || {
        connection_id: connection.id,
        local_date: date,
        source: "garmin",
        fetched_at: null,
        missing: true,
        ...Object.fromEntries(fields.map((field) => [field, null])),
      },
  );
  return {
    items: complete,
    connectionId: connection.id,
    source: "garmin",
    range: { start, end },
  };
}
export async function dashboard(env: Env, userId: string, date: string) {
  const connection = await ownerConnection(env, userId);
  const health = connection
    ? await env.DB.prepare(
        "SELECT * FROM daily_health WHERE connection_id=? AND local_date=?",
      )
        .bind(connection.id, date)
        .first<Record<string, number | null>>()
    : null;
  const training = connection
    ? await env.DB.prepare(
        "SELECT * FROM training_metrics WHERE connection_id=? AND local_date=?",
      )
        .bind(connection.id, date)
        .first()
    : null;
  const activity = await activityPage(env, userId, { limit: 5 });
  const start = new Date(Date.parse(date) - 6 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const trends = await dateRows(env, userId, "daily_health", start, date);
  const lastSuccessfulSync = connection?.last_synced_at || null;
  const status = !lastSuccessfulSync
    ? "not_synced"
    : Date.now() - Date.parse(lastSuccessfulSync) > 6 * 3600_000
      ? "stale"
      : "fresh";
  return {
    date,
    timezone: APP_TIMEZONE,
    source: "garmin" as const,
    connectionId: connection?.id || null,
    freshness: { lastSuccessfulSync, status },
    metrics: {
      steps: health?.steps ?? null,
      distanceM: health?.distance_m ?? null,
      sleepSeconds: health?.sleep_seconds ?? null,
      restingHr: health?.resting_hr ?? null,
    },
    activities: activity.items,
    trends: trends.items,
    training,
  };
}
export function defaultRange(_env: Env) {
  const end = dateInZone(APP_TIMEZONE);
  const start = new Date(Date.parse(end) - 29 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return { start, end };
}
