import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../apps/worker/src";
import { sha256 } from "../apps/worker/src/lib/crypto";
import { env, origin, fixture } from "./helpers";

let cookie = "";
const request = (path: string, options: RequestInit = {}) =>
  app.request(origin + path, options, env);
const headers = () => ({
  Origin: origin,
  Cookie: cookie,
  "Content-Type": "application/json",
});
const input = {
  name: "Test client",
  scopes: ["profile:read", "activities:read"],
  expiresInDays: 30,
};
async function create() {
  const response = await request("/api/v1/mcp/pats", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(input),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return (
    await response.json<{
      data: { id: string; token: string; expiresAt: number };
    }>()
  ).data;
}
const mcp = (
  token: string,
  method = "tools/list",
  params: Record<string, unknown> = {},
) =>
  request("/mcp", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-11-25",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

beforeAll(async () => {
  cookie = (await fixture()).cookie;
});
describe("MCP personal access tokens through the project API", () => {
  it("requires an owner web session and same origin to manage keys", async () => {
    expect((await request("/api/v1/mcp/pats")).status).toBe(401);
    expect(
      (
        await request("/api/v1/mcp/pats", {
          method: "POST",
          headers: { ...headers(), Origin: "https://evil.test" },
          body: JSON.stringify(input),
        })
      ).status,
    ).toBe(403);
    const key = await create();
    expect(
      (
        await request("/api/v1/mcp/pats", {
          headers: { Authorization: "Bearer " + key.token },
        })
      ).status,
    ).toBe(401);
  });
  it("stores only a hash, reveals the key once, and limits scopes and expiry", async () => {
    const key = await create();
    expect(key.token).toMatch(/^gmp_pat_[A-Za-z0-9_-]{43}$/);
    expect(key.expiresAt).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    const row = await env.DB.prepare(
      "SELECT * FROM mcp_personal_access_tokens WHERE id=?",
    )
      .bind(key.id)
      .first();
    expect(row?.token_hash).toBe(await sha256(key.token));
    expect(JSON.stringify(row)).not.toContain(key.token);
    const list = await request("/api/v1/mcp/pats", { headers: headers() });
    const text = await list.text();
    expect(text).toContain(key.id);
    expect(text).not.toContain(key.token);
    expect(text).not.toContain("token_hash");
    for (const invalid of [
      { ...input, scopes: ["admin:write"] },
      { ...input, scopes: [] },
      { ...input, scopes: ["offline_access"] },
      { ...input, scopes: ["profile:read", "profile:read"] },
      { ...input, expiresInDays: 0 },
      { ...input, expiresInDays: 366 },
      { ...input, name: " " },
    ])
      expect(
        (
          await request("/api/v1/mcp/pats", {
            method: "POST",
            headers: headers(),
            body: JSON.stringify(invalid),
          })
        ).status,
      ).toBe(400);
  });
  it("supports MCP initialization, scoped tools and last-used tracking", async () => {
    const key = await create();
    const initialized = await mcp(key.token, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "pat-test", version: "1" },
    });
    expect(initialized.status, await initialized.clone().text()).toBe(200);
    const list = await mcp(key.token);
    expect(list.status, await list.clone().text()).toBe(200);
    const data = await list.json<{ result: { tools: { name: string }[] } }>();
    expect(data.result.tools.map((tool) => tool.name)).toContain(
      "get_activities",
    );
    expect(data.result.tools.map((tool) => tool.name)).not.toContain(
      "get_activity_track",
    );
    const allowed = await mcp(key.token, "tools/call", {
      name: "get_profile",
      arguments: {},
    });
    expect(await allowed.json()).toMatchObject({
      result: { structuredContent: { source: "garmin", data: null } },
    });
    const denied = await mcp(key.token, "tools/call", {
      name: "get_daily_health",
      arguments: { date: "2026-11-26" },
    });
    expect(await denied.json()).toMatchObject({
      result: {
        isError: true,
        content: [{ text: JSON.stringify({ code: "INSUFFICIENT_SCOPE" }) }],
      },
    });
    const row = await env.DB.prepare(
      "SELECT last_used_at FROM mcp_personal_access_tokens WHERE id=?",
    )
      .bind(key.id)
      .first();
    expect(row?.last_used_at).toBeGreaterThan(0);
  });
  it("revokes immediately without affecting another key or the owner session", async () => {
    const a = await create(),
      b = await create();
    const revoke = await request(`/api/v1/mcp/pats/${a.id}/revoke`, {
      method: "POST",
      headers: headers(),
      body: "{}",
    });
    expect(revoke.status).toBe(200);
    expect((await mcp(a.token)).status).toBe(401);
    expect((await mcp(b.token)).status).toBe(200);
    expect((await request("/api/v1/me", { headers: headers() })).status).toBe(
      200,
    );
  });
  it("rejects expired, wrong-resource, corrupt and malformed keys and query-string credentials", async () => {
    const key = await create();
    await env.DB.prepare(
      "UPDATE mcp_personal_access_tokens SET expires_at=? WHERE id=?",
    )
      .bind(Date.now() - 1, key.id)
      .run();
    expect((await mcp(key.token)).status).toBe(401);
    await env.DB.prepare(
      "UPDATE mcp_personal_access_tokens SET expires_at=?,resource=? WHERE id=?",
    )
      .bind(Date.now() + 86_400_000, "https://wrong.test/mcp", key.id)
      .run();
    expect((await mcp(key.token)).status).toBe(401);
    await env.DB.prepare(
      "UPDATE mcp_personal_access_tokens SET resource=?,scopes=? WHERE id=?",
    )
      .bind(origin + "/mcp", '["admin:write"]', key.id)
      .run();
    expect((await mcp(key.token)).status).toBe(401);
    expect((await mcp("gmp_pat_" + "a".repeat(43))).status).toBe(401);
    expect((await mcp(key.token + "!")).status).toBe(401);
    expect((await request("/mcp?access_token=" + key.token)).status).toBe(401);
  });
  it("keeps PAT access independent of the web session but still requires the instance owner role", async () => {
    const key = await create();
    await env.DB.prepare("UPDATE session SET expiresAt=?")
      .bind(Date.now() - 1)
      .run();
    expect((await request("/api/v1/me", { headers: headers() })).status).toBe(
      401,
    );
    expect((await mcp(key.token)).status).toBe(200);
    await env.DB.prepare('UPDATE "user" SET role=?').bind("member").run();
    expect((await mcp(key.token)).status).toBe(401);
  });
});
