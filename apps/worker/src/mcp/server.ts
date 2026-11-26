import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Env } from "../env";
import { verifyMcpToken, requireScopes, type McpPrincipal } from "../auth/mcp";
import { ServiceError, safeCode } from "../lib/errors";
import {
  activityPage,
  getActivity,
  activityDetails,
  dateRows,
  dateSchema,
  rangeSchema,
  defaultRange,
  ownerConnection,
} from "../services/queries";

const period = z
  .object({ start: dateSchema.optional(), end: dateSchema.optional() })
  .strict();
const activityId = z.object({ id: z.string().min(1).max(100) }).strict();
type Tool = {
  name: string;
  description: string;
  scopes: string[];
  schema: z.ZodObject;
  run: (
    input: Record<string, unknown>,
    principal: McpPrincipal,
  ) => Promise<unknown>;
};

function tools(env: Env): Tool[] {
  const range = (input: Record<string, unknown>) => {
    const defaults = defaultRange(env);
    const result = rangeSchema.safeParse({
      start: input.start || defaults.start,
      end: input.end || defaults.end,
    });
    if (!result.success) throw new ServiceError("INVALID_DATE_RANGE");
    return result.data;
  };
  const activityProjection = (
    value: Record<string, unknown>,
    principal: McpPrincipal,
  ) => {
    const { source_hash: _hash, ...activity } = value;
    if (!principal.scopes.includes("location:read"))
      activity.name = activity.sport_type;
    if (!principal.scopes.includes("health:read")) {
      delete activity.avg_hr;
      delete activity.max_hr;
      delete activity.calories_kcal;
    }
    return activity;
  };
  return [
    {
      name: "get_profile",
      description:
        "Read the connected Garmin display name and region. Does not return email or credentials.",
      scopes: ["profile:read"],
      schema: z.object({}).strict(),
      run: async (_input, principal) => {
        const row = await ownerConnection(env, principal.userId);
        return row
          ? {
              displayName: row.display_name,
              region: row.region,
              status: row.status,
            }
          : null;
      },
    },
    {
      name: "get_activities",
      description:
        "List synchronized activity summaries with bounded cursor pagination. Distances in metres; durations in seconds.",
      scopes: ["activities:read"],
      schema: period.extend({
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().max(2048).optional(),
        sport: z.string().max(60).optional(),
      }),
      run: async (input, principal) => {
        const dates = range(input);
        const page = await activityPage(env, principal.userId, {
          ...dates,
          limit: input.limit as number | undefined,
          cursor: input.cursor as string | undefined,
          sport: input.sport as string | undefined,
        });
        return {
          ...page,
          items: page.items.map((item) => activityProjection(item, principal)),
        };
      },
    },
    {
      name: "get_activity",
      description:
        "Read one synchronized activity summary, without coordinates or unauthorized health fields.",
      scopes: ["activities:read"],
      schema: activityId,
      run: async (input, principal) =>
        activityProjection(
          await getActivity(env, principal.userId, String(input.id)),
          principal,
        ),
    },
    {
      name: "get_activity_splits",
      description:
        "Read FIT laps. Heart rate fields require health:read in addition to activities:read.",
      scopes: ["activities:read"],
      schema: activityId,
      run: async (input, principal) => {
        const details = await activityDetails(
          env,
          principal.userId,
          String(input.id),
          50,
        );
        return details.laps.map((lap) => {
          if (principal.scopes.includes("health:read")) return lap;
          const { avg_hr: _hr, ...safe } = lap;
          return safe;
        });
      },
    },
    {
      name: "get_activity_track",
      description:
        "Read a downsampled GPS LineString from the archived FIT, up to 2000 points.",
      scopes: ["activities:read", "location:read"],
      schema: activityId,
      run: async (input, principal) => {
        const details = await activityDetails(
          env,
          principal.userId,
          String(input.id),
        );
        return {
          type: "LineString",
          coordinates: details.track,
          originalSampleCount: details.sampleCount,
        };
      },
    },
    {
      name: "get_daily_health",
      description:
        "Read daily steps, resting heart rate, HRV, stress and body battery. Sleep requires its separate tool and scope.",
      scopes: ["health:read"],
      schema: z.object({ date: dateSchema }).strict(),
      run: async (input, principal) =>
        healthProjection(
          await dateRows(
            env,
            principal.userId,
            "daily_health",
            String(input.date),
            String(input.date),
          ),
        ),
    },
    {
      name: "get_health_trends",
      description:
        "Read synchronized health trends over at most 366 calendar days, excluding sleep fields.",
      scopes: ["health:read"],
      schema: period,
      run: async (input, principal) => {
        const dates = range(input);
        return healthProjection(
          await dateRows(
            env,
            principal.userId,
            "daily_health",
            dates.start,
            dates.end,
          ),
        );
      },
    },
    {
      name: "get_sleep",
      description:
        "Read sleep duration in seconds and sleep score over a bounded date range.",
      scopes: ["sleep:read"],
      schema: period,
      run: async (input, principal) => {
        const dates = range(input);
        const data = await dateRows(
          env,
          principal.userId,
          "daily_health",
          dates.start,
          dates.end,
        );
        return {
          ...data,
          items: data.items.map((row) => ({
            date: row.local_date,
            sleep_seconds: row.sleep_seconds,
            sleep_score: row.sleep_score,
            fetched_at: row.fetched_at,
            source: row.source,
          })),
        };
      },
    },
    {
      name: "get_training_status",
      description:
        "Read device-supported VO2 max, readiness and training load. Missing metrics remain null.",
      scopes: ["training:read"],
      schema: period,
      run: async (input, principal) => {
        const dates = range(input);
        return dateRows(
          env,
          principal.userId,
          "training_metrics",
          dates.start,
          dates.end,
        );
      },
    },
    {
      name: "get_running_statistics",
      description:
        "Aggregate synchronized running distance, time and activity count over a bounded date range.",
      scopes: ["activities:read"],
      schema: period,
      run: async (input, principal) => {
        const dates = range(input);
        const row = await ownerConnection(env, principal.userId);
        if (!row) return null;
        return env.DB.prepare(
          "SELECT count(*) AS activities,sum(a.distance_m) AS distance_m,sum(a.duration_s) AS duration_s FROM activities a JOIN provider_connections c ON c.id=a.connection_id WHERE c.user_id=? AND a.connection_id=? AND a.local_date>=? AND a.local_date<=? AND a.sport_type LIKE '%running%'",
        )
          .bind(principal.userId, row.id, dates.start, dates.end)
          .first();
      },
    },
    {
      name: "get_personal_records",
      description:
        "Read synchronized Garmin personal records. Unsupported records return an empty list.",
      scopes: ["activities:read"],
      schema: z.object({}).strict(),
      run: async (_input, principal) => {
        const row = await ownerConnection(env, principal.userId);
        if (!row) return [];
        return (
          await env.DB.prepare(
            "SELECT r.type,r.value,r.unit,r.recorded_at,r.fetched_at FROM personal_records r JOIN provider_connections c ON c.id=r.connection_id WHERE c.user_id=? AND r.connection_id=? LIMIT 200",
          )
            .bind(principal.userId, row.id)
            .all()
        ).results;
      },
    },
  ];
}
function healthProjection(data: Awaited<ReturnType<typeof dateRows>>) {
  return {
    ...data,
    items: data.items.map((row) => {
      const {
        sleep_seconds: _seconds,
        sleep_score: _score,
        availability: _availability,
        ...health
      } = row;
      return health;
    }),
  };
}
export async function mcpResponse(
  env: Env,
  request: Request,
): Promise<Response> {
  if (new URL(request.url).host !== new URL(env.APP_URL).host)
    return Response.json({ error: "invalid_host" }, { status: 403 });
  const origin = request.headers.get("Origin");
  const allowed = [
    new URL(env.APP_URL).origin,
    ...(env.MCP_ALLOWED_ORIGINS || "").split(",").filter(Boolean),
  ];
  if (origin && !allowed.includes(origin))
    return Response.json({ error: "invalid_origin" }, { status: 403 });
  const headers = new Headers({
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Expose-Headers": "WWW-Authenticate, MCP-Session-Id",
    "Cache-Control": "no-store",
  });
  if (request.method === "OPTIONS") {
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    headers.set(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id",
    );
    return new Response(null, { status: 204, headers });
  }
  let principal: McpPrincipal;
  try {
    principal = await verifyMcpToken(env, request);
  } catch {
    headers.set(
      "WWW-Authenticate",
      `Bearer resource_metadata="${new URL(env.APP_URL).origin}/.well-known/oauth-protected-resource/mcp"`,
    );
    return Response.json({ error: "invalid_token" }, { status: 401, headers });
  }
  const definitions = tools(env);
  const server = new Server(
    { name: "cf-garmin-mcp", version: "1.0.0-dev.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const current = await verifyMcpToken(env, request);
    return {
      tools: definitions
        .filter((tool) =>
          tool.scopes.every((scope) => current.scopes.includes(scope)),
        )
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: z.toJSONSchema(tool.schema) as { type: "object" },
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        })),
    };
  });
  server.setRequestHandler(CallToolRequestSchema, async (call) => {
    try {
      const current = await verifyMcpToken(env, request);
      const tool = definitions.find(
        (definition) => definition.name === call.params.name,
      );
      if (!tool) throw new ServiceError("UNKNOWN_TOOL", 404);
      requireScopes(current, tool.scopes);
      const result = tool.schema.safeParse(call.params.arguments || {});
      if (!result.success) throw new ServiceError("INVALID_TOOL_ARGUMENTS");
      const data = await tool.run(result.data, current);
      // Recheck after reading too, so an authorization revoked during a slow FIT
      // parse is not used to return a newly assembled response.
      await verifyMcpToken(env, request);
      await env.DB.prepare(
        "INSERT INTO client_access_log VALUES (?,?,?) ON CONFLICT(user_id,client_id) DO UPDATE SET last_accessed_at=excluded.last_accessed_at",
      )
        .bind(current.userId, current.clientId, new Date().toISOString())
        .run();
      const connection = await ownerConnection(env, current.userId);
      const output = {
        source: "garmin",
        units: {
          distance: "m",
          duration: "s",
          speed: "m/s",
          power: "W",
          heartRate: "bpm",
        },
        freshness: { lastSuccessfulSync: connection?.last_synced_at || null },
        data,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output) }],
        structuredContent: output,
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ code: safeCode(error) }),
          },
        ],
      };
    }
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: 65_536,
  });
  await server.connect(transport);
  const response = await transport.handleRequest(request, {
    authInfo: {
      token: principal.tokenHash,
      clientId: principal.clientId,
      scopes: principal.scopes,
    },
  });
  response.headers.forEach((value, key) => headers.set(key, value));
  return new Response(response.body, { status: response.status, headers });
}
