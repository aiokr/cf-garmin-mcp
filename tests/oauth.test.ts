import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../apps/worker/src";
import { env, origin, fixture } from "./helpers";

let cookie = "";
let clientA: Awaited<ReturnType<typeof grant>>;
let clientB: Awaited<ReturnType<typeof grant>>;
const request = (path: string, options: RequestInit = {}) =>
  app.request(origin + path, options, env);
const ownerHeaders = () => ({
  Origin: origin,
  Cookie: cookie,
  "Content-Type": "application/json",
});

async function grant(name: string, scope: string) {
  const registered = await request("/api/auth/oauth2/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [`https://${name}.example.test/callback`],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
    }),
  });
  expect(registered.status, await registered.clone().text()).toBe(201);
  const client = await registered.json<{ client_id: string }>();
  const verifier = `${name}-pkce-verifier-with-at-least-forty-three-random-characters-2026`;
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  const challenge = btoa(String.fromCharCode(...digest))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  const query = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: `https://${name}.example.test/callback`,
    response_type: "code",
    scope,
    state: name + "-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: origin + "/mcp",
  });
  const authorization = await request("/api/auth/oauth2/authorize?" + query, {
    headers: { Cookie: cookie },
  });
  expect(authorization.status, await authorization.clone().text()).toBe(302);
  const consentUrl = new URL(authorization.headers.get("Location")!, origin);
  expect(consentUrl.pathname).toBe("/consent");
  const preview = await request("/api/v1/oauth/request" + consentUrl.search, {
    headers: { Cookie: cookie },
  });
  expect(preview.status, await preview.clone().text()).toBe(200);
  const details = await preview.json<{ data: { oauthQuery: string } }>();
  const consent = await request("/api/auth/oauth2/consent", {
    method: "POST",
    headers: ownerHeaders(),
    body: JSON.stringify({
      accept: true,
      scope,
      oauth_query: details.data.oauthQuery,
    }),
  });
  expect(consent.status, await consent.clone().text()).toBe(200);
  const next = await consent.json<{ url: string }>();
  const callback = new URL(next.url);
  expect(callback.searchParams.get("state")).toBe(name + "-state");
  const code = callback.searchParams.get("code")!;
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: client.client_id,
    redirect_uri: `https://${name}.example.test/callback`,
    code_verifier: verifier,
    resource: origin + "/mcp",
  });
  // A wrong verifier cannot spend or redeem the code.
  const wrong = new URLSearchParams(form);
  wrong.set(
    "code_verifier",
    "wrong-verifier-which-is-long-enough-to-pass-shape-validation-2026",
  );
  expect(
    (
      await request("/api/auth/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: wrong,
      })
    ).status,
  ).toBe(400);
  const token = await request("/api/auth/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  expect(token.status, await token.clone().text()).toBe(200);
  return {
    clientId: client.client_id,
    ...(await token.json<{ access_token: string; refresh_token?: string }>()),
  };
}
async function mcp(
  token: string,
  method: string,
  params: Record<string, unknown> = {},
) {
  return request("/mcp", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-11-25",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}
beforeAll(async () => {
  cookie = (await fixture()).cookie;
});
describe.sequential("OAuth PKCE, independent clients and stateless MCP", () => {
  it("publishes RFC discovery and a protected resource challenge", async () => {
    const challenge = await request("/mcp");
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("WWW-Authenticate")).toContain(
      "/.well-known/oauth-protected-resource/mcp",
    );
    const metadata = await request(
      "/.well-known/oauth-authorization-server/api/auth",
    );
    expect(metadata.status, await metadata.clone().text()).toBe(200);
    expect(await metadata.json()).toMatchObject({
      issuer: origin + "/api/auth",
      code_challenge_methods_supported: ["S256"],
    });
  });
  it("completes actual authorization-code + PKCE exchanges for two independently registered clients", async () => {
    clientA = await grant(
      "client-a",
      "profile:read activities:read offline_access",
    );
    clientB = await grant("client-b", "profile:read");
    expect(clientA.refresh_token).toBeTruthy();
    expect(clientA.access_token).not.toBe(clientB.access_token);
  });
  it("filters tools by scopes and denies direct calls outside the grant", async () => {
    const list = await mcp(clientA.access_token, "tools/list");
    expect(list.status, await list.clone().text()).toBe(200);
    const data = await list.json<{ result: { tools: { name: string }[] } }>();
    expect(data.result.tools.map((tool) => tool.name)).toContain(
      "get_activities",
    );
    expect(data.result.tools.map((tool) => tool.name)).not.toContain(
      "get_activity_track",
    );
    const denied = await mcp(clientA.access_token, "tools/call", {
      name: "get_daily_health",
      arguments: { date: "2026-11-26" },
    });
    expect(await denied.json()).toMatchObject({
      result: {
        isError: true,
        content: [{ text: JSON.stringify({ code: "INSUFFICIENT_SCOPE" }) }],
      },
    });
    const allowed = await mcp(clientB.access_token, "tools/call", {
      name: "get_profile",
      arguments: {},
    });
    expect(allowed.status).toBe(200);
    const apps = await request("/api/v1/connected-apps", {
      headers: { Cookie: cookie },
    });
    expect(await apps.text()).toContain("last_accessed_at");
  });
  it("revokes A access and refresh immediately while B and the owner session continue", async () => {
    const patResponse = await request("/api/v1/mcp/pats", {
      method: "POST",
      headers: ownerHeaders(),
      body: JSON.stringify({
        name: "OAuth coexistence",
        scopes: ["profile:read"],
        expiresInDays: 30,
      }),
    });
    expect(patResponse.status).toBe(201);
    const { data: pat } = await patResponse.json<{
      data: { id: string; token: string };
    }>();
    const revoked = await request(
      `/api/v1/connected-apps/${clientA.clientId}/revoke`,
      { method: "POST", headers: ownerHeaders(), body: "{}" },
    );
    expect(revoked.status, await revoked.clone().text()).toBe(200);
    expect((await mcp(clientA.access_token, "tools/list")).status).toBe(401);
    expect((await mcp(clientB.access_token, "tools/list")).status).toBe(200);
    expect((await mcp(pat.token, "tools/list")).status).toBe(200);
    expect(
      (
        await request(`/api/v1/mcp/pats/${pat.id}/revoke`, {
          method: "POST",
          headers: ownerHeaders(),
          body: "{}",
        })
      ).status,
    ).toBe(200);
    expect((await mcp(pat.token, "tools/list")).status).toBe(401);
    expect((await mcp(clientB.access_token, "tools/list")).status).toBe(200);
    expect(
      (await request("/api/v1/me", { headers: { Cookie: cookie } })).status,
    ).toBe(200);
    const refresh = await request("/api/auth/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: clientA.refresh_token!,
        client_id: clientA.clientId,
        resource: origin + "/mcp",
      }),
    });
    expect(refresh.status).toBe(400);
  });
  it("rejects expired tokens and wrong audiences even if the token hash exists", async () => {
    await env.DB.prepare(
      "UPDATE oauthAccessToken SET resources=? WHERE clientId=?",
    )
      .bind(
        JSON.stringify(["https://wrong.example.test/mcp"]),
        clientB.clientId,
      )
      .run();
    expect((await mcp(clientB.access_token, "tools/list")).status).toBe(401);
    await env.DB.prepare(
      "UPDATE oauthAccessToken SET resources=?,expiresAt=? WHERE clientId=?",
    )
      .bind(JSON.stringify([origin + "/mcp"]), Date.now() - 1, clientB.clientId)
      .run();
    expect((await mcp(clientB.access_token, "tools/list")).status).toBe(401);
  });
});
