import { env as workerEnv } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { betterAuth } from "better-auth";
import app from "../apps/worker/src";
import { authOptions } from "../apps/worker/src/auth/config";
import { providerStatus } from "../apps/worker/src/providers/garmin/config";
import type { Env } from "../apps/worker/src/env";
import type { D1Migration } from "cloudflare:test";

const env = workerEnv as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };
const origin = "https://garmin.test";
const secret = "test-only-bootstrap-secret-at-least-32-characters";
const password = "Original-test-password-2026";
const owner = {
  name: "Test Owner",
  email: "owner@example.test",
  password,
  secret,
};
const request = (
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) =>
  app.request(
    `${origin}${path}`,
    {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Origin: origin,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  );
let cookie = "";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe.sequential("single-owner lifecycle in Workers + D1 + DO", () => {
  it("rejects anonymous data access, external origins, missing origins and public signup", async () => {
    expect((await request("/api/v1/me")).status).toBe(401);
    expect(
      (
        await request("/api/v1/bootstrap", owner, {
          Origin: "https://evil.test",
        })
      ).status,
    ).toBe(403);
    const missingOrigin = await app.request(
      `${origin}/api/v1/bootstrap`,
      { method: "POST", body: JSON.stringify(owner) },
      env,
    );
    expect(missingOrigin.status).toBe(403);
    expect((await request("/api/auth/sign-up/email", owner)).status).toBe(404);
    expect(
      (
        await request("/api/v1/bootstrap", {
          ...owner,
          secret: "wrong-secret-value-longer-than-32-characters",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await env.DB.prepare('SELECT count(*) AS n FROM "user"').first<{
          n: number;
        }>()
      )?.n,
    ).toBe(0);
  });

  it("atomically creates one owner under concurrent bootstrap requests and permanently closes bootstrap", async () => {
    const responses = await Promise.all([
      request("/api/v1/bootstrap", owner),
      request("/api/v1/bootstrap", { ...owner, email: "racer@example.test" }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      201, 409,
    ]);
    expect(
      (
        await env.DB.prepare('SELECT count(*) AS n FROM "user"').first<{
          n: number;
        }>()
      )?.n,
    ).toBe(1);
    expect(
      (
        await env.DB.prepare("SELECT count(*) AS n FROM account").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(1);
    const account = await env.DB.prepare("SELECT password FROM account").first<{
      password: string;
    }>();
    expect(account?.password).not.toBe(password);
    expect(account?.password).not.toContain(secret);
    expect((await request("/api/v1/bootstrap", owner)).status).toBe(409);
    const status = await (
      await request("/api/v1/instance")
    ).json<{ data: { initialized: boolean; bootstrapAvailable: boolean } }>();
    expect(status.data).toMatchObject({
      initialized: true,
      bootstrapAvailable: false,
    });
    await expect(
      env.DB.prepare("UPDATE instance_state SET owner_user_id = NULL").run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        'INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt",role) VALUES (?,?,?,0,0,0,?)',
      )
        .bind("intruder", "Intruder", "other@example.test", "owner")
        .run(),
    ).rejects.toThrow();
  });

  it("signs in using Better Auth with Secure HttpOnly cookies and reads only the owner", async () => {
    const probe = await env.OAUTH_COORDINATOR.get(
      env.OAUTH_COORDINATOR.idFromName("oauth"),
    ).fetch(`${origin}/api/auth/get-session`);
    expect(probe.status, await probe.clone().text()).toBe(200);
    const user = await env.DB.prepare('SELECT email FROM "user"').first<{
      email: string;
    }>();
    const response = await request("/api/auth/sign-in/email", {
      email: user!.email,
      password,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const setCookie = response.headers.get("set-cookie")!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    cookie = setCookie.split(";")[0]!;
    const me = await request("/api/v1/me", undefined, { Cookie: cookie });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      data: { name: "Test Owner", role: "owner" },
    });
    expect(me.headers.get("cache-control")).toBe("no-store");
  });

  it("preserves missing data and validates date and protocol boundaries", async () => {
    const response = await request("/api/v1/dashboard", undefined, {
      Cookie: cookie,
    });
    expect(response.status).toBe(200);
    const body = await response.json<{
      data: { metrics: Record<string, unknown> };
    }>();
    expect(Object.values(body.data.metrics)).toEqual([null, null, null, null]);
    expect(
      (
        await request("/api/v1/dashboard?date=2026-02-30", undefined, {
          Cookie: cookie,
        })
      ).status,
    ).toBe(400);
    expect((await request("/api/v1/sync", {}, { Cookie: cookie })).status).toBe(
      409,
    );
    expect((await request("/mcp")).status).toBe(401);
    expect(
      (await request("/.well-known/oauth-authorization-server")).status,
    ).toBe(404);
    expect(
      (await request("/api/unknown")).headers.get("content-type"),
    ).toContain("application/json");
    const connection = await request("/api/v1/connections", undefined, {
      Cookie: cookie,
    });
    expect(await connection.text()).not.toMatch(
      /encrypted_tokens|password|personal_api_key/i,
    );
  });

  it("changes the password, revokes sessions on logout and denies the old password", async () => {
    const changed = await request(
      "/api/auth/change-password",
      {
        currentPassword: password,
        newPassword: "Changed-test-password-2026",
        revokeOtherSessions: true,
      },
      { Cookie: cookie },
    );
    expect(changed.status, await changed.clone().text()).toBe(200);
    expect(
      (await request("/api/auth/sign-out", {}, { Cookie: cookie })).status,
    ).toBe(200);
    expect(
      (await request("/api/v1/me", undefined, { Cookie: cookie })).status,
    ).toBe(401);
    const user = await env.DB.prepare('SELECT email FROM "user"').first<{
      email: string;
    }>();
    expect(
      (
        await request("/api/auth/sign-in/email", {
          email: user!.email,
          password,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request("/api/auth/sign-in/email", {
          email: user!.email,
          password: "Changed-test-password-2026",
        })
      ).status,
    ).toBe(200);
  });

  it("persists a bounded login throttle in the Durable Object", async () => {
    const responses = [];
    for (let i = 0; i < 12; i++)
      responses.push(
        await request("/api/auth/sign-in/email", {
          email: "none@example.test",
          password,
        }),
      );
    expect(responses.some((response) => response.status === 429)).toBe(true);
    expect(responses.at(-1)?.headers.get("Retry-After")).toBe("60");
  });

  it("fails closed for an incomplete deployment", async () => {
    const response = await app.request(`${origin}/api/v1/instance`, undefined, {
      ...env,
      BETTER_AUTH_SECRET: "",
    });
    expect(response.status).toBe(503);
  });
});

describe("M0 compatibility probes", () => {
  it("composes the locked Better Auth OAuth Provider against D1", async () => {
    const auth = betterAuth(authOptions(env));
    const context = await auth.$context;
    expect(context.options.plugins?.map((plugin) => plugin.id)).toContain(
      "oauth-provider",
    );
    expect(Object.keys(context.tables)).toContain("oauthClient");
  });

  it.each(["CN", "GLOBAL"])(
    "validates both configured authentication modes for %s without returning secrets",
    (region) => {
      const api = providerStatus({
        ...env,
        GARMIN_REGION: region,
        GARMIN_AUTH_MODE: "personal_api",
        GARMIN_PERSONAL_API_KEY: "not-a-real-key",
      });
      const credentials = providerStatus({
        ...env,
        GARMIN_REGION: region,
        GARMIN_AUTH_MODE: "credentials",
        GARMIN_PERSONAL_API_KEY: "",
        GARMIN_EMAIL: "private@example.test",
        GARMIN_PASSWORD: "private-password",
      });
      expect(api.configured).toBe(true);
      expect(credentials.configured).toBe(true);
      expect(JSON.stringify(credentials)).not.toContain("private");
      expect(
        providerStatus({
          ...env,
          GARMIN_REGION: region,
          GARMIN_PERSONAL_API_KEY: "key",
          GARMIN_PASSWORD: "password",
        }).configured,
      ).toBe(false);
    },
  );
});
