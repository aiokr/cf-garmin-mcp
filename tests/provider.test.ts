import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { env, fixture } from "./helpers";
import {
  login,
  refresh,
  completeMfa,
  type Tokens,
} from "../apps/worker/src/providers/garmin/auth";
import { identity } from "../apps/worker/src/providers/garmin/client";
import {
  garminCommand,
  readProvider,
} from "../apps/worker/src/durable-objects/garmin-auth";
import {
  seal,
  open,
  credentialFingerprint,
} from "../apps/worker/src/lib/crypto";
import { upstream } from "../apps/worker/src/providers/garmin/http";
import type { Env } from "../apps/worker/src/env";

const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
const token = () =>
  "header." +
  btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })) +
  ".signature";
let userId = "";
beforeAll(async () => {
  userId = (await fixture()).userId;
});
afterEach(() => vi.restoreAllMocks());

describe("Garmin protocol adapters (synthetic upstream responses)", () => {
  it.each(["CN", "GLOBAL"] as const)(
    "handles Personal API and credentials + refresh for %s without cross-region fallback",
    async (region) => {
      const suffix = region === "CN" ? "garmin.cn" : "garmin.com";
      let exchange = 0;
      const password = "  synthetic-password-with-spaces\n!  ";
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = new URL(String(input));
        expect(url.hostname.endsWith(suffix)).toBe(true);
        if (url.pathname.endsWith("/personal-api-key/token"))
          return new Response(token());
        if (url.pathname.includes("/mobile/sso/"))
          return new Response("", {
            headers: { "Set-Cookie": "test-session=synthetic; Path=/" },
          });
        if (url.pathname.endsWith("/mobile/api/login")) {
          expect(JSON.parse(String(init?.body)).password).toBe(password);
          return json({
            responseStatus: { type: "SUCCESSFUL" },
            serviceTicketId: "synthetic-service-ticket",
          });
        }
        if (url.pathname.endsWith("/oauth/token")) {
          const body = new URLSearchParams(String(init?.body));
          expect([
            "refresh_token",
            "https://connectapi.garmin.com/di-oauth2-service/oauth/grant/service_ticket",
          ]).toContain(body.get("grant_type"));
          if (body.has("service_url"))
            expect(body.get("service_url")).toContain(suffix);
          exchange++;
          return json({
            access_token: token(),
            refresh_token: "synthetic-refresh",
            expires_in: 3600,
          });
        }
        if (url.pathname.endsWith("/socialProfile"))
          return json({ profileId: 42, displayName: "synthetic-owner" });
        throw new Error("Unexpected test upstream request");
      });
      const personal: Env = {
        ...env,
        GARMIN_REGION: region,
        GARMIN_AUTH_MODE: "personal_api",
      };
      const result = await login(personal);
      expect(result.status).toBe("ok");
      if (result.status !== "ok") throw new Error();
      expect((await identity(personal, result.tokens)).id).toBe("42");
      const credentials: Env = {
        ...env,
        GARMIN_REGION: region,
        GARMIN_AUTH_MODE: "credentials",
        GARMIN_PERSONAL_API_KEY: "",
        GARMIN_EMAIL: "synthetic@example.test",
        GARMIN_PASSWORD: password,
      };
      const signedIn = await login(credentials);
      expect(signedIn.status).toBe("ok");
      if (signedIn.status !== "ok") throw new Error();
      expect((await refresh(credentials, signedIn.tokens)).status).toBe("ok");
      expect(exchange).toBe(2);
    },
  );

  it("pauses for MFA and refuses CAPTCHA without attempting a bypass", async () => {
    const config = {
      ...env,
      GARMIN_AUTH_MODE: "credentials",
      GARMIN_PERSONAL_API_KEY: "",
      GARMIN_EMAIL: "synthetic@example.test",
      GARMIN_PASSWORD: "synthetic-password",
    };
    let captcha = false;
    const mock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes("/mobile/sso/"))
          return new Response("", {
            headers: { "Set-Cookie": "mfa-session=synthetic" },
          });
        if (url.includes("/mobile/api/login"))
          return json({
            responseStatus: {
              type: captcha ? "CAPTCHA_REQUIRED" : "MFA_REQUIRED",
            },
            customerMfaInfo: { mfaLastMethodUsed: "email" },
          });
        if (url.includes("/mfa/verifyCode"))
          return json({
            responseStatus: { type: "SUCCESSFUL" },
            serviceTicketId: "synthetic-ticket",
          });
        if (url.includes("/oauth/token"))
          return json({
            access_token: token(),
            refresh_token: "synthetic-refresh",
          });
        throw new Error("Unexpected test upstream request");
      });
    const result = await login(config);
    if (result.status !== "mfa") throw new Error("Expected MFA");
    expect((await completeMfa(result.pending, "123456")).refreshToken).toBe(
      "synthetic-refresh",
    );
    captcha = true;
    const previous = mock.mock.calls.length;
    await expect(login(config)).rejects.toMatchObject({
      code: "PROVIDER_CAPTCHA_REQUIRED",
    });
    expect(mock.mock.calls.length - previous).toBe(2);
  });

  it("honors Retry-After and bounds 5xx and 401 retries", async () => {
    const mock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response("", { status: 429, headers: { "Retry-After": "120" } }),
      );
    await expect(upstream("https://test.example.test")).rejects.toMatchObject({
      code: "UPSTREAM_RATE_LIMITED",
      retryAfter: 120,
    });
    expect(mock).toHaveBeenCalledTimes(1);
    mock.mockImplementation(async () => new Response("", { status: 503 }));
    await expect(
      upstream("https://test.example.test", {}, 1),
    ).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    expect(mock).toHaveBeenCalledTimes(3);
    mock.mockImplementation(async () => new Response("", { status: 401 }));
    await expect(upstream("https://test.example.test")).rejects.toMatchObject({
      code: "PROVIDER_UNAUTHORIZED",
    });
    expect(mock).toHaveBeenCalledTimes(4);
  });
});

describe.sequential(
  "encrypted tokens and the per-connection coordinator",
  () => {
    const id = crypto.randomUUID();
    it("binds encryption to owner/connection/region and supports a previous key during rotation", async () => {
      const context = {
        userId: "owner",
        connectionId: "connection",
        region: "CN",
      };
      const encrypted = await seal(env, context, { token: "synthetic-secret" });
      expect(encrypted).not.toContain("synthetic-secret");
      expect(await seal(env, context, { token: "synthetic-secret" })).not.toBe(
        encrypted,
      );
      await expect(
        open(env, { ...context, connectionId: "another" }, encrypted),
      ).rejects.toMatchObject({ code: "TOKEN_DECRYPTION_FAILED" });
      const rotated = {
        ...env,
        PROVIDER_KEY_VERSION: "2",
        PROVIDER_ENCRYPTION_KEY_PREVIOUS: env.PROVIDER_ENCRYPTION_KEY,
        PROVIDER_ENCRYPTION_KEY: btoa("01234567890123456789012345678901"),
      };
      expect(await open(rotated, context, encrypted)).toEqual({
        token: "synthetic-secret",
      });
    });
    it("single-flights concurrent renewal, persists the rotated token, then blocks reads after disconnect", async () => {
      let exchanges = 0;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        if (String(input).includes("/personal-api-key/token")) {
          exchanges++;
          return new Response(token());
        }
        if (String(input).includes("/socialProfile"))
          return json({ profileId: 42, displayName: "synthetic-owner" });
        throw new Error("Unexpected test upstream request");
      });
      await env.DB.prepare(
        "INSERT INTO provider_connections(id,user_id,region,auth_type,external_user_id,status) VALUES (?,?,?,?,?,?)",
      )
        .bind(id, userId, "CN", "personal_api", "pending:" + id, "pending")
        .run();
      await garminCommand(env, {
        userId,
        connectionId: id,
        action: "verify",
        sessionId: "synthetic-session",
      });
      expect(exchanges).toBe(1);
      const context = { userId, connectionId: id, region: "CN" };
      const row = await env.DB.prepare(
        "SELECT encrypted_tokens FROM provider_connections WHERE id=?",
      )
        .bind(id)
        .first<{ encrypted_tokens: string }>();
      const tokens = await open<Tokens>(env, context, row!.encrypted_tokens);
      tokens.expiresAt = 0;
      await env.DB.prepare(
        "UPDATE provider_connections SET encrypted_tokens=? WHERE id=?",
      )
        .bind(await seal(env, context, tokens), id)
        .run();
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          readProvider(env, { id, user_id: userId }, "profile"),
        ),
      );
      expect(results).toHaveLength(8);
      expect(exchanges).toBe(2);
      const persisted = await env.DB.prepare(
        "SELECT encrypted_tokens,credential_fingerprint FROM provider_connections WHERE id=?",
      )
        .bind(id)
        .first<{ encrypted_tokens: string; credential_fingerprint: string }>();
      expect(
        (await open<Tokens>(env, context, persisted!.encrypted_tokens))
          .expiresAt,
      ).toBeGreaterThan(Date.now());
      expect(persisted?.credential_fingerprint).toBe(
        await credentialFingerprint(env),
      );
      await garminCommand(env, { userId, connectionId: id, action: "revoke" });
      await expect(
        readProvider(env, { id, user_id: userId }, "profile"),
      ).rejects.toMatchObject({ code: "CONNECTION_REVOKED" });
      expect(exchanges).toBe(2);
      expect(
        (
          await env.DB.prepare(
            "SELECT encrypted_tokens FROM provider_connections WHERE id=?",
          )
            .bind(id)
            .first()
        )?.encrypted_tokens,
      ).toBeNull();
    });
    it("binds MFA challenges to a session and rejects expired state before upstream access", async () => {
      const mfaId = crypto.randomUUID();
      await env.DB.prepare(
        "INSERT INTO provider_connections(id,user_id,region,auth_type,external_user_id,status) VALUES (?,?,?,?,?,?)",
      )
        .bind(
          mfaId,
          userId,
          "CN",
          "personal_api",
          "pending:" + mfaId,
          "pending",
        )
        .run();
      const stub = env.GARMIN_AUTH.get(env.GARMIN_AUTH.idFromName(mfaId));
      const challengeId = crypto.randomUUID();
      await runInDurableObject(stub, async (_instance, state) => {
        await state.storage.put("pending", {
          id: challengeId,
          sessionId: "original-session",
          expiresAt: Date.now() + 60_000,
          attempts: 0,
          encrypted: "not-read-for-wrong-session",
        });
      });
      await expect(
        garminCommand(env, {
          userId,
          connectionId: mfaId,
          action: "mfa",
          sessionId: "other-session",
          challengeId,
          code: "123456",
        }),
      ).rejects.toMatchObject({ code: "MFA_CHALLENGE_INVALID" });
      await runInDurableObject(stub, async (_instance, state) => {
        await state.storage.put("pending", {
          id: challengeId,
          sessionId: "original-session",
          expiresAt: Date.now() - 1,
          attempts: 0,
          encrypted: "not-read-for-expired-state",
        });
      });
      await expect(
        garminCommand(env, {
          userId,
          connectionId: mfaId,
          action: "mfa",
          sessionId: "original-session",
          challengeId,
          code: "123456",
        }),
      ).rejects.toMatchObject({ code: "MFA_CHALLENGE_INVALID" });
    });
  },
);
