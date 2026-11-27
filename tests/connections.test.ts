import { beforeAll, expect, it } from "vitest";
import app from "../apps/worker/src";
import { env, fixture, origin } from "./helpers";

let userId = "";
let cookie = "";
beforeAll(async () => {
  ({ userId, cookie } = await fixture());
});

it("lists full account names without unverified failed attempts, retaining verified history and pending MFA", async () => {
  const fullName = "full-garmin-account-display-name-123456789";
  const rows = [
    ["connected", "42", fullName],
    ["error", "pending:failed-1", null],
    ["error", "pending:failed-2", null],
    ["revoked", "pending:abandoned", null],
    ["revoked", "old-account", "Historical Owner"],
    ["error", "verified-account", "Needs Retry"],
  ];
  for (const [status, externalId, name] of rows) {
    await env.DB.prepare(
      "INSERT INTO provider_connections(id,user_id,region,auth_type,external_user_id,display_name,status) VALUES (?,?,?,?,?,?,?)",
    )
      .bind(
        crypto.randomUUID(),
        userId,
        "CN",
        "personal_api",
        externalId,
        name,
        status,
      )
      .run();
  }
  const response = await app.request(
    `${origin}/api/v1/connections`,
    { headers: { Cookie: cookie } },
    env,
  );
  expect(response.status).toBe(200);
  const body = await response.json<{
    data: { connections: { display_name: string | null; status: string }[] };
  }>();
  expect(body.data.connections).toHaveLength(3);
  expect(
    body.data.connections.find((row) => row.status === "connected")
      ?.display_name,
  ).toBe(fullName);
  expect(body.data.connections.map((row) => row.display_name)).toContain(
    "Historical Owner",
  );
  expect(body.data.connections.map((row) => row.display_name)).toContain(
    "Needs Retry",
  );
  await env.DB.prepare(
    "UPDATE provider_connections SET status='pending', external_user_id='pending:mfa' WHERE user_id=? AND status='connected'",
  )
    .bind(userId)
    .run();
  const pendingResponse = await app.request(
    `${origin}/api/v1/connections`,
    { headers: { Cookie: cookie } },
    env,
  );
  const pendingBody = await pendingResponse.json<{
    data: { connections: { status: string }[] };
  }>();
  expect(
    pendingBody.data.connections.some((row) => row.status === "pending"),
  ).toBe(true);
});
