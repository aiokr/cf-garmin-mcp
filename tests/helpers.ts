import { env as workerEnv } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import type { Env } from "../apps/worker/src/env";
import { initializeOwner } from "../apps/worker/src/auth/bootstrap";
import { createAuth } from "../apps/worker/src/auth/config";
export const env = workerEnv as unknown as Env & {
  TEST_MIGRATIONS: D1Migration[];
};
export const origin = "https://garmin.test";
export async function fixture() {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await initializeOwner(env, {
    name: "Fixture Owner",
    email: "fixture@example.test",
    password: "Fixture-test-password-2026!",
    secret: "fixture-only-not-a-real-secret-value",
  });
  const user = await env.DB.prepare('SELECT id FROM "user"').first<{
    id: string;
  }>();
  const response = await createAuth(env).api.signInEmail({
    body: {
      email: "fixture@example.test",
      password: "Fixture-test-password-2026!",
    },
    headers: new Headers({ Origin: origin }),
    asResponse: true,
  });
  if (response.status !== 200)
    throw new Error(`Fixture login failed: ${response.status}`);
  return {
    userId: user!.id,
    cookie: response.headers.get("set-cookie")!.split(";")[0]!,
  };
}
