import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { bootstrapSchema, type Owner } from "../../../packages/shared/src";
import { createAuth } from "./auth/config";
import { initializeOwner, isInitialized } from "./auth/bootstrap";
import { SCOPES } from "./auth/mcp";
import { apiRoutes } from "./routes/api";
import { mcpResponse } from "./mcp/server";
import { ServiceError } from "./lib/errors";
import { runScheduled } from "./services/scheduler";
import type { Env } from "./env";

export { InstanceGuard } from "./durable-objects/instance-guard";
export { GarminAuth } from "./durable-objects/garmin-auth";
export { OAuthCoordinator } from "./durable-objects/oauth-coordinator";
export { SyncWorkflow } from "./workflows/sync";

export const app = new Hono<{
  Bindings: Env;
  Variables: { requestId: string; owner: Owner; sessionId: string };
}>();
const messages: Record<string, string> = {
  AUTH_REQUIRED: "请先登录。",
  FORBIDDEN: "无法执行此操作。",
  ORIGIN_REJECTED: "请求来源无效。",
  NOT_CONFIGURED: "服务配置尚未完成。",
  ALREADY_INITIALIZED: "账户已创建。",
  INVALID_INPUT: "请检查输入内容。",
  RATE_LIMITED: "请求过于频繁，请稍后重试。",
  NOT_FOUND: "内容不存在。",
  PROVIDER_REAUTH_REQUIRED: "请重新验证 Garmin 连接。",
  PROVIDER_OPERATION_UNSUPPORTED:
    "官方 Garmin Personal API 不提供训练状态、VO2max 和训练准备度；请使用支持这些指标的已授权连接。",
  PROVIDER_DATA_UNAVAILABLE: "Garmin 接口或数据不可用，请检查账号区域配置。",
  PROVIDER_UNAUTHORIZED: "Garmin 授权已失效，请检查个人 API Key 并重新验证。",
  INVALID_PROVIDER_IDENTITY: "Garmin 返回的账号资料不完整，无法验证连接。",
  UPSTREAM_NETWORK_ERROR: "无法访问 Garmin 服务，请检查网络后重试。",
  PROVIDER_CAPTCHA_REQUIRED:
    "Garmin 要求验证码验证，请先在 Garmin 完成验证后重试。",
  PROVIDER_BLOCKED: "Garmin 暂时拒绝了连接，请稍后重试。",
  PROVIDER_CREDENTIALS_REJECTED: "Garmin 凭据验证失败。",
  PROVIDER_ACCOUNT_CHANGED: "账号已变更，请断开旧连接后连接新账号。",
  PROVIDER_CONFIGURATION_CHANGED: "连接配置已变更，请重新验证。",
  UPSTREAM_RATE_LIMITED: "Garmin 请求过于频繁，请稍后重试。",
  ACTIVE_CONNECTION_EXISTS: "已有连接，请先完成验证或断开连接。",
  ACTIVITY_FILE_UNAVAILABLE: "原始文件尚不可用。",
  INVALID_MFA_CODE: "验证码无效，请重试。",
  MFA_CHALLENGE_INVALID: "验证已过期，请重新连接。",
  INTERNAL_ERROR: "操作失败，请使用请求编号排查。",
};
const protocolPosts = new Set([
  "/api/auth/oauth2/token",
  "/api/auth/oauth2/register",
  "/api/auth/oauth2/introspect",
  "/api/auth/oauth2/revoke",
]);

app.use(
  "*",
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      workerSrc: ["'self'", "blob:"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:", "https:"],
      connectSrc: ["'self'", "https://tile.openstreetmap.org"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
      baseUri: ["'self'"],
    },
    referrerPolicy: "no-referrer",
  }),
);
app.use("*", async (c, next) => {
  c.set("requestId", crypto.randomUUID());
  c.header("X-Request-Id", c.get("requestId"));
  c.header("Cache-Control", "no-store");
  await next();
});
app.use(
  "/api/*",
  bodyLimit({
    maxSize: 16_384,
    onError: (c) =>
      c.json(
        {
          error: { code: "INVALID_INPUT", message: messages.INVALID_INPUT },
          requestId: c.get("requestId"),
        },
        413,
      ),
  }),
);
app.use("/api/*", async (c, next) => {
  if (
    new URL(c.req.url).protocol === "https:" &&
    new URL(c.env.APP_URL).protocol !== "https:"
  )
    throw new ServiceError("NOT_CONFIGURED", 503);
  try {
    createAuth(c.env);
  } catch {
    throw new ServiceError("NOT_CONFIGURED", 503);
  }
  const path = new URL(c.req.url).pathname;
  if (
    !["GET", "HEAD", "OPTIONS"].includes(c.req.method) &&
    !protocolPosts.has(path) &&
    c.req.header("Origin") !== new URL(c.env.APP_URL).origin
  )
    throw new ServiceError("ORIGIN_REJECTED", 403);
  await next();
});
app.get("/api/v1/instance", async (c) => {
  const initialized = await isInitialized(c.env.DB);
  return c.json({
    data: {
      initialized,
      bootstrapAvailable: !initialized,
      stage: "development",
    },
    requestId: c.get("requestId"),
  });
});
app.post("/api/v1/bootstrap", async (c) => {
  if (await isInitialized(c.env.DB))
    throw new ServiceError("ALREADY_INITIALIZED", 409);
  if (!(await throttle(c.env, "bootstrap", 5, 60)))
    throw new ServiceError("RATE_LIMITED", 429, 60);
  const parsed = bootstrapSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) throw new ServiceError("INVALID_INPUT");
  try {
    await initializeOwner(c.env, parsed.data);
  } catch (error) {
    if (await isInitialized(c.env.DB))
      throw new ServiceError("ALREADY_INITIALIZED", 409);
    throw error;
  }
  return c.json(
    { data: { initialized: true }, requestId: c.get("requestId") },
    201,
  );
});
app.on(["GET", "POST", "OPTIONS"], "/api/auth/*", async (c) => {
  const path = new URL(c.req.url).pathname;
  if (
    c.req.method === "GET" &&
    path === "/api/auth/.well-known/oauth-authorization-server"
  )
    return oauthProviderAuthServerMetadata(createAuth(c.env), {
      headers: { "Access-Control-Allow-Origin": "*" },
    })(c.req.raw);
  const allowed =
    c.req.method === "GET"
      ? ["/api/auth/get-session", "/api/auth/oauth2/authorize"]
      : [
          "/api/auth/sign-in/email",
          "/api/auth/sign-out",
          "/api/auth/change-password",
          "/api/auth/oauth2/consent",
          ...protocolPosts,
        ];
  if (!allowed.includes(path)) throw new ServiceError("NOT_FOUND", 404);
  if (protocolPosts.has(path)) {
    c.header("Access-Control-Allow-Origin", "*");
    if (c.req.method === "OPTIONS") {
      c.header("Access-Control-Allow-Methods", "POST, OPTIONS");
      c.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
      return c.body(null, 204);
    }
    if (!(await throttle(c.env, "oauth-protocol", 30, 60)))
      throw new ServiceError("RATE_LIMITED", 429, 60);
  }
  if (
    path === "/api/auth/sign-in/email" &&
    !(await throttle(c.env, "login", 10, 60))
  )
    throw new ServiceError("RATE_LIMITED", 429, 60);
  let request = new Request(c.req.raw, { redirect: "manual" });
  if (protocolPosts.has(path)) {
    const headers = new Headers(request.headers);
    headers.delete("Cookie");
    request = new Request(request, { headers });
  }
  const stub = c.env.OAUTH_COORDINATOR.get(
    c.env.OAUTH_COORDINATOR.idFromName("oauth"),
  );
  const response = await stub.fetch(request);
  return new Response(response.body, response);
});
app.use("/api/v1/*", async (c, next) => {
  const session = await createAuth(c.env).api.getSession({
    headers: c.req.raw.headers,
  });
  if (!session) throw new ServiceError("AUTH_REQUIRED", 401);
  const state = await c.env.DB.prepare(
    "SELECT owner_user_id FROM instance_state WHERE id = 1",
  ).first<{ owner_user_id: string }>();
  if (state?.owner_user_id !== session.user.id || session.user.role !== "owner")
    throw new ServiceError("FORBIDDEN", 403);
  c.set("owner", {
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
    role: session.user.role,
  });
  c.set("sessionId", session.session.id);
  await next();
});
app.route("/api/v1", apiRoutes);
app.all("/mcp", (c) => mcpResponse(c.env, c.req.raw));
app.get("/.well-known/oauth-authorization-server/api/auth", (c) =>
  oauthProviderAuthServerMetadata(createAuth(c.env), {
    headers: { "Access-Control-Allow-Origin": "*" },
  })(c.req.raw),
);
app.get("/api/auth/.well-known/oauth-authorization-server", (c) =>
  oauthProviderAuthServerMetadata(createAuth(c.env), {
    headers: { "Access-Control-Allow-Origin": "*" },
  })(c.req.raw),
);
for (const path of [
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
])
  app.get(path, (c) => {
    c.header("Access-Control-Allow-Origin", "*");
    return c.json({
      resource: new URL(c.env.APP_URL).origin + "/mcp",
      authorization_servers: [new URL(c.env.APP_URL).origin + "/api/auth"],
      scopes_supported: SCOPES,
      bearer_methods_supported: ["header"],
    });
  });
app.all("/.well-known/*", (c) =>
  c.json(
    {
      error: { code: "NOT_FOUND", message: messages.NOT_FOUND },
      requestId: c.get("requestId"),
    },
    404,
  ),
);
app.all("/api/*", (c) =>
  c.json(
    {
      error: { code: "NOT_FOUND", message: messages.NOT_FOUND },
      requestId: c.get("requestId"),
    },
    404,
  ),
);
app.notFound(async (c) => {
  const response = await c.env.ASSETS.fetch(c.req.raw);
  return new Response(response.body, response);
});
app.onError((error, c) => {
  const code = error instanceof ServiceError ? error.code : "INTERNAL_ERROR";
  if (!(error instanceof ServiceError))
    console.error(
      JSON.stringify({
        event: "request_failed",
        requestId: c.get("requestId"),
      }),
    );
  if (error instanceof ServiceError && error.retryAfter)
    c.header("Retry-After", String(error.retryAfter));
  return c.json(
    {
      error: { code, message: messages[code] || "操作失败，请稍后重试。" },
      requestId: c.get("requestId"),
    },
    (error instanceof ServiceError
      ? error.status
      : 500) as ContentfulStatusCode,
  );
});
async function throttle(
  env: Env,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const stub = env.INSTANCE_GUARD.get(env.INSTANCE_GUARD.idFromName("owner"));
  const response = await stub.fetch("https://guard.internal/limit", {
    method: "POST",
    body: JSON.stringify({ key, limit, windowSeconds }),
  });
  return response.ok && (await response.json<{ allowed: boolean }>()).allowed;
}
export default Object.assign(app, {
  scheduled: async (
    event: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ) => {
    ctx.waitUntil(runScheduled(env, event.cron));
  },
});
