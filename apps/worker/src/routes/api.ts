import { Hono } from "hono";
import { z } from "zod";
import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import type { Env } from "../env";
import type { Owner } from "../../../../packages/shared/src";
import { ServiceError } from "../lib/errors";
import { pruneSyncHistory } from "../services/sync-history";
import { createAuth } from "../auth/config";
import { stringArray } from "../auth/mcp";
import { createPat } from "../auth/pat";
import { createPatSchema } from "../../../../packages/shared/src";
import { providerStatus } from "../providers/garmin/config";
import { garminCommand } from "../durable-objects/garmin-auth";
import { seal } from "../lib/crypto";
import {
  activityPage,
  getActivity,
  getActivityFile,
  activityDetails,
  dateRows,
  dashboard,
  dateSchema,
  rangeSchema,
  ownerConnection,
  defaultRange,
} from "../services/queries";
import { dateInZone, startSync } from "../services/sync";

type AppEnv = {
  Bindings: Env;
  Variables: { requestId: string; owner: Owner; sessionId: string };
};
export const apiRoutes = new Hono<AppEnv>();
const parsed = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new ServiceError("INVALID_INPUT");
  return result.data;
};
const uuid = z.uuid();
const body = async (request: { json: () => Promise<unknown> }) =>
  request.json().catch(() => {
    throw new ServiceError("INVALID_INPUT");
  });

apiRoutes.get("/me", (c) =>
  c.json({ data: c.get("owner"), requestId: c.get("requestId") }),
);
apiRoutes.get("/dashboard", async (c) => {
  const date = parsed(
    dateSchema,
    c.req.query("date") || dateInZone(c.env.APP_TIMEZONE),
  );
  return c.json({
    data: await dashboard(c.env, c.get("owner").id, date),
    requestId: c.get("requestId"),
  });
});
apiRoutes.get("/activities", async (c) => {
  const query = parsed(
    z.object({
      connectionId: uuid.optional(),
      start: dateSchema.optional(),
      end: dateSchema.optional(),
      sport: z.string().max(60).optional(),
      search: z.string().max(100).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      cursor: z.string().max(2048).optional(),
    }),
    c.req.query(),
  );
  if (query.start && query.end && query.start > query.end)
    throw new ServiceError("INVALID_DATE_RANGE");
  return c.json({
    data: await activityPage(c.env, c.get("owner").id, query),
    requestId: c.get("requestId"),
  });
});
apiRoutes.get("/activities/:id", async (c) => {
  const activity = await getActivity(
    c.env,
    c.get("owner").id,
    c.req.param("id"),
  );
  const files = await c.env.DB.prepare(
    "SELECT id,format,status,size_bytes,error_code FROM activity_files WHERE activity_id=?",
  )
    .bind(activity.id)
    .all();
  return c.json({
    data: { ...activity, files: files.results },
    requestId: c.get("requestId"),
  });
});
apiRoutes.get("/activities/:id/details", async (c) => {
  const maxPoints = parsed(
    z.coerce.number().int().min(50).max(5000),
    c.req.query("maxPoints") || 2000,
  );
  const { track: _track, ...details } = await activityDetails(
    c.env,
    c.get("owner").id,
    c.req.param("id"),
    maxPoints,
  );
  return c.json({ data: details, requestId: c.get("requestId") });
});
apiRoutes.get("/activities/:id/track", async (c) => {
  const details = await activityDetails(
    c.env,
    c.get("owner").id,
    c.req.param("id"),
  );
  return c.json({
    data: {
      type: "Feature",
      geometry: { type: "LineString", coordinates: details.track },
      properties: { source: "garmin", sampleCount: details.sampleCount },
    },
    requestId: c.get("requestId"),
  });
});
apiRoutes.get("/activities/:id/files/:fileId", async (c) => {
  const { file, bytes } = await getActivityFile(
    c.env,
    c.get("owner").id,
    c.req.param("id"),
    c.req.param("fileId"),
  );
  return new Response(bytes, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": 'attachment; filename="activity.fit"',
      "Cache-Control": "private, no-store",
      "Content-Length": String(file.size_bytes),
      "X-Content-Type-Options": "nosniff",
    },
  });
});
for (const [path, table] of [
  ["/health", "daily_health"],
  ["/training", "training_metrics"],
] as const) {
  apiRoutes.get(path, async (c) => {
    const defaults = defaultRange(c.env);
    const range = parsed(rangeSchema, {
      start: c.req.query("start") || defaults.start,
      end: c.req.query("end") || defaults.end,
    });
    const connectionId = c.req.query("connectionId");
    if (connectionId) parsed(uuid, connectionId);
    return c.json({
      data: await dateRows(
        c.env,
        c.get("owner").id,
        table,
        range.start,
        range.end,
        connectionId,
      ),
      requestId: c.get("requestId"),
    });
  });
}
apiRoutes.get("/connections", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT id,region,auth_type,display_name,status,last_verified_at,last_synced_at,last_error_code FROM provider_connections WHERE user_id=? AND NOT (external_user_id LIKE 'pending:%' AND status IN ('error','revoked')) ORDER BY last_verified_at DESC",
  )
    .bind(c.get("owner").id)
    .all<{ display_name: string | null }>();
  // Failed attempts without a verified identity are not Garmin accounts.
  // This owner-only endpoint returns full names; presentation truncation is CSS-only.
  const connections = rows.results;
  return c.json({
    data: { provider: providerStatus(c.env), connections },
    requestId: c.get("requestId"),
  });
});
apiRoutes.post("/connections", async (c) => {
  const config = providerStatus(c.env);
  if (!config.configured)
    throw new ServiceError(config.code || "INVALID_PROVIDER_CONFIGURATION");
  const active = await c.env.DB.prepare(
    "SELECT id FROM provider_connections WHERE user_id=? AND status IN ('connected','pending') LIMIT 1",
  )
    .bind(c.get("owner").id)
    .first();
  if (active) throw new ServiceError("ACTIVE_CONNECTION_EXISTS", 409);
  const id = crypto.randomUUID();
  const userId = c.get("owner").id;
  await seal(
    c.env,
    { userId, connectionId: id, region: config.region! },
    { check: true },
  );
  await c.env.DB.prepare(
    "INSERT INTO provider_connections (id,user_id,region,auth_type,external_user_id,status) VALUES (?,?,?,?,?,?)",
  )
    .bind(id, userId, config.region, config.mode, `pending:${id}`, "pending")
    .run();
  try {
    const result = await (
      await garminCommand(c.env, {
        userId,
        connectionId: id,
        action: "verify",
        sessionId: c.get("sessionId"),
      })
    ).json<Record<string, unknown>>();
    if (result.status === "connected")
      c.executionCtx.waitUntil(
        queueInitialSync(c.env, userId, id).catch(() => undefined),
      );
    return c.json(
      { data: { ...result, id }, requestId: c.get("requestId") },
      201,
    );
  } catch (error) {
    await c.env.DB.prepare(
      "UPDATE provider_connections SET status='error',last_error_code=? WHERE id=? AND status='pending'",
    )
      .bind(
        error instanceof ServiceError ? error.code : "CONNECTION_FAILED",
        id,
      )
      .run();
    throw error;
  }
});
apiRoutes.post("/connections/:id/:action", async (c) => {
  const id = parsed(uuid, c.req.param("id"));
  const action = parsed(
    z.enum(["mfa", "verify", "rotate"]),
    c.req.param("action"),
  );
  const connection = await ownerConnection(c.env, c.get("owner").id, id);
  if (!connection) throw new ServiceError("CONNECTION_NOT_FOUND", 404);
  const data =
    action === "mfa"
      ? parsed(
          z
            .object({
              challengeId: uuid,
              code: z.string().regex(/^[\da-zA-Z-]{4,12}$/),
            })
            .strict(),
          await body(c.req),
        )
      : {};
  const result = await (
    await garminCommand(c.env, {
      userId: c.get("owner").id,
      connectionId: id,
      action,
      sessionId: c.get("sessionId"),
      ...data,
    })
  ).json<Record<string, unknown>>();
  if (result.status === "connected")
    c.executionCtx.waitUntil(
      queueInitialSync(c.env, c.get("owner").id, id).catch(() => undefined),
    );
  return c.json({ data: result, requestId: c.get("requestId") });
});
apiRoutes.delete("/connections/:id", async (c) => {
  const id = parsed(uuid, c.req.param("id"));
  const userId = c.get("owner").id;
  await ownerConnection(c.env, userId, id);
  const response = await garminCommand(c.env, {
    userId,
    connectionId: id,
    action: "revoke",
  });
  await c.env.DB.prepare(
    "UPDATE sync_runs SET status='cancelled',finished_at=?,updated_at=? WHERE connection_id=? AND status IN ('queued','running')",
  )
    .bind(new Date().toISOString(), new Date().toISOString(), id)
    .run();
  return c.json({ data: await response.json(), requestId: c.get("requestId") });
});
apiRoutes.post("/sync", async (c) => {
  const value = parsed(
    z
      .object({
        connectionId: uuid.optional(),
        stream: z
          .enum(["all", "activities", "health", "training", "files", "devices"])
          .default("all"),
        mode: z.enum(["incremental", "backfill"]).default("incremental"),
        start: dateSchema.optional(),
        end: dateSchema.optional(),
      })
      .strict(),
    await body(c.req),
  );
  const connection = await ownerConnection(
    c.env,
    c.get("owner").id,
    value.connectionId,
  );
  if (!connection || connection.status !== "connected")
    throw new ServiceError("PROVIDER_REAUTH_REQUIRED", 409);
  const end = value.end || dateInZone(c.env.APP_TIMEZONE);
  const start =
    value.start ||
    new Date(Date.parse(end) - 6 * 86_400_000).toISOString().slice(0, 10);
  if (start > end || end > dateInZone(c.env.APP_TIMEZONE))
    throw new ServiceError("INVALID_DATE_RANGE");
  if (
    value.stream !== "activities" &&
    !rangeSchema.safeParse({ start, end }).success
  )
    throw new ServiceError("DATE_RANGE_TOO_LARGE");
  const runs = [];
  for (const stream of value.stream === "all"
    ? ["activities", "health", "training", "files", "devices"]
    : [value.stream]) {
    if (
      stream === "training" &&
      connection.auth_type === "personal_api" &&
      value.stream === "all"
    )
      continue;
    runs.push(
      await startSync(c.env, connection, stream, start, end, value.mode),
    );
  }
  return c.json({ data: { runs }, requestId: c.get("requestId") }, 202);
});
apiRoutes.get("/sync/runs", async (c) => {
  await pruneSyncHistory(c.env);
  const rows = await c.env.DB.prepare(
    "SELECT r.* FROM sync_runs r JOIN provider_connections c ON c.id=r.connection_id WHERE c.user_id=? ORDER BY r.started_at DESC,r.id DESC LIMIT 96",
  )
    .bind(c.get("owner").id)
    .all();
  const items = await Promise.all(
    rows.results.map(async (run) => {
      if (
        run.status !== "partial" ||
        !["health", "training"].includes(String(run.stream))
      )
        return run;
      const table =
        run.stream === "health" ? "daily_health" : "training_metrics";
      // Current per-source availability for this owner-authorized run's date window.
      const daily = await c.env.DB.prepare(
        `SELECT availability FROM ${table} WHERE connection_id=? AND local_date BETWEEN ? AND ?`,
      )
        .bind(run.connection_id, run.start_date, run.end_date)
        .all<{ availability: string }>();
      const missing = new Set<string>();
      for (const day of daily.results) {
        try {
          const sources = JSON.parse(day.availability) as Record<
            string,
            { status: string }
          >;
          for (const [source, value] of Object.entries(sources))
            if (value.status !== "available")
              missing.add(source + ":" + value.status);
        } catch {
          /* Legacy availability may be absent. */
        }
      }
      return { ...run, unavailable_sources: [...missing] };
    }),
  );
  return c.json({
    data: { items },
    requestId: c.get("requestId"),
  });
});
apiRoutes.get("/settings", async (c) => {
  const settings = await c.env.DB.prepare(
    "SELECT health_history_days,activity_history_days,auto_sync,archive_fit FROM owner_settings WHERE user_id=?",
  )
    .bind(c.get("owner").id)
    .first();
  return c.json({
    data: {
      ...(settings || {
        health_history_days: 90,
        activity_history_days: 365,
        auto_sync: 1,
        archive_fit: 1,
      }),
      mapTileUrl:
        c.env.OSM_TILE_URL || "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      timezone: c.env.APP_TIMEZONE,
      mcpUrl: new URL(c.env.APP_URL).origin + "/mcp",
    },
    requestId: c.get("requestId"),
  });
});
apiRoutes.put("/settings", async (c) => {
  const settings = parsed(
    z
      .object({
        health_history_days: z.number().int().min(1).max(365),
        activity_history_days: z.number().int().min(1).max(7300),
        auto_sync: z.boolean(),
        archive_fit: z.boolean(),
      })
      .strict(),
    await body(c.req),
  );
  await c.env.DB.prepare(
    "INSERT INTO owner_settings VALUES (?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET health_history_days=excluded.health_history_days,activity_history_days=excluded.activity_history_days,auto_sync=excluded.auto_sync,archive_fit=excluded.archive_fit",
  )
    .bind(
      c.get("owner").id,
      settings.health_history_days,
      settings.activity_history_days,
      Number(settings.auto_sync),
      Number(settings.archive_fit),
    )
    .run();
  return c.json({ data: { saved: true }, requestId: c.get("requestId") });
});
apiRoutes.get("/mcp/pats", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id,name,hint,scopes,
    created_at AS createdAt,expires_at AS expiresAt,last_used_at AS lastUsedAt,
    revoked_at AS revokedAt FROM mcp_personal_access_tokens
    WHERE user_id=? ORDER BY created_at DESC`,
  )
    .bind(c.get("owner").id)
    .all();
  return c.json({
    data: {
      items: rows.results.map((row) => ({
        ...row,
        scopes: stringArray(row.scopes as string),
      })),
    },
    requestId: c.get("requestId"),
  });
});
apiRoutes.post("/mcp/pats", async (c) => {
  const input = parsed(createPatSchema, await body(c.req));
  return c.json(
    {
      data: await createPat(c.env, c.get("owner").id, input),
      requestId: c.get("requestId"),
    },
    201,
  );
});
apiRoutes.post("/mcp/pats/:id/revoke", async (c) => {
  const id = parsed(uuid, c.req.param("id"));
  const result = await c.env.DB.prepare(
    `UPDATE mcp_personal_access_tokens
    SET revoked_at=COALESCE(revoked_at,?) WHERE id=? AND user_id=?`,
  )
    .bind(Date.now(), id, c.get("owner").id)
    .run();
  if (!result.meta.changes) throw new ServiceError("NOT_FOUND", 404);
  return c.json({ data: { revoked: true }, requestId: c.get("requestId") });
});
apiRoutes.get("/connected-apps", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT co.clientId,co.scopes,co.createdAt,c.name,c.uri,l.last_accessed_at FROM oauthConsent co JOIN oauthClient c ON c.clientId=co.clientId LEFT JOIN client_access_log l ON l.client_id=co.clientId AND l.user_id=co.userId WHERE co.userId=? ORDER BY co.createdAt DESC",
  )
    .bind(c.get("owner").id)
    .all<{ scopes: string }>();
  return c.json({
    data: {
      items: rows.results.map((row) => ({
        ...row,
        scopes: stringArray(row.scopes),
      })),
    },
    requestId: c.get("requestId"),
  });
});
apiRoutes.post("/connected-apps/:clientId/revoke", async (c) => {
  const clientId = parsed(z.string().min(1).max(512), c.req.param("clientId"));
  const stub = c.env.OAUTH_COORDINATOR.get(
    c.env.OAUTH_COORDINATOR.idFromName("oauth"),
  );
  const result = await stub.fetch("https://oauth.internal/internal/revoke", {
    method: "POST",
    body: JSON.stringify({ userId: c.get("owner").id, clientId }),
  });
  if (!result.ok) throw new ServiceError("REVOCATION_FAILED", 503);
  return c.json({ data: await result.json(), requestId: c.get("requestId") });
});
apiRoutes.get("/oauth/request", async (c) => {
  const params = new URL(c.req.url).searchParams;
  const signed = new Set(["sig", "ba_param", ...params.getAll("ba_param")]);
  const query = new URLSearchParams(
    [...params].filter(([key]) => signed.has(key)),
  ).toString();
  const auth = createAuth(c.env);
  const { secret } = await auth.$context;
  if (!(await verifyOAuthQueryParams(query, secret)))
    throw new ServiceError("INVALID_AUTHORIZATION_REQUEST");
  const values = new URLSearchParams(query);
  const clientId = values.get("client_id");
  if (!clientId) throw new ServiceError("INVALID_AUTHORIZATION_REQUEST");
  const client = await auth.api.getOAuthClientPublic({
    headers: c.req.raw.headers,
    query: { client_id: clientId },
  });
  return c.json({
    data: {
      clientId,
      name: client.client_name || clientId,
      redirectUri: values.get("redirect_uri"),
      scopes: (values.get("scope") || "").split(" ").filter(Boolean),
      oauthQuery: query,
    },
    requestId: c.get("requestId"),
  });
});

async function queueInitialSync(env: Env, userId: string, id: string) {
  const connection = await ownerConnection(env, userId, id);
  if (!connection || connection.status !== "connected") return;
  const end = dateInZone(env.APP_TIMEZONE);
  const start = new Date(Date.parse(end) - 6 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  for (const stream of ["activities", "health", "training", "devices"]) {
    if (stream === "training" && connection.auth_type === "personal_api")
      continue;
    const cursor = await env.DB.prepare(
      "SELECT checkpoint FROM sync_cursors WHERE connection_id=? AND stream=?",
    )
      .bind(id, stream)
      .first();
    try {
      await startSync(
        env,
        connection,
        stream,
        start,
        end,
        "incremental",
        !cursor,
      );
    } catch {
      // Keep other streams independent; startSync retains a failed diagnostic row
      // when Workflow creation fails, so the owner can retry the exact window.
      console.error(
        JSON.stringify({ event: "initial_sync_start_failed", stream }),
      );
    }
  }
}
