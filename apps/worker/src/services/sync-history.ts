import type { Env } from "../env";

export const SYNC_HISTORY_LIMIT = 96;

// Rank per owner, not per connection. Never remove a live Workflow's run row.
export async function pruneSyncHistory(env: Env) {
  await env.DB.prepare(
    `
    DELETE FROM sync_runs WHERE id IN (
      SELECT id FROM (
        SELECT r.id,r.status,ROW_NUMBER() OVER (
          PARTITION BY c.user_id ORDER BY r.started_at DESC,r.id DESC
        ) AS position
        FROM sync_runs r JOIN provider_connections c ON c.id=r.connection_id
      ) WHERE position > ? AND status NOT IN ('queued','running')
    )
  `,
  )
    .bind(SYNC_HISTORY_LIMIT)
    .run();
}
