import { hashPassword } from "better-auth/crypto";
import type { BootstrapInput } from "../../../../packages/shared/src";
import type { Env } from "../env";

export async function initializeOwner(
  env: Env,
  input: BootstrapInput,
): Promise<void> {
  const userId = crypto.randomUUID();
  const password = await hashPassword(input.password);
  const now = Date.now();
  // D1 batch is transactional. The user trigger and singleton make concurrent
  // bootstrap requests mutually exclusive, including across Worker instances.
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", role) VALUES (?, ?, ?, 0, ?, ?, ?)',
    ).bind(userId, input.name, input.email, now, now, "owner"),
    env.DB.prepare(
      'INSERT INTO account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(
      crypto.randomUUID(),
      userId,
      "credential",
      userId,
      password,
      now,
      now,
    ),
    env.DB.prepare(
      "UPDATE instance_state SET owner_user_id = ?, initialized_at = ? WHERE id = 1 AND owner_user_id IS NULL",
    ).bind(userId, now),
  ]);
}

export async function isInitialized(db: D1Database): Promise<boolean> {
  const state = await db
    .prepare("SELECT owner_user_id FROM instance_state WHERE id = 1")
    .first<{ owner_user_id: string | null }>();
  return Boolean(state?.owner_user_id);
}
