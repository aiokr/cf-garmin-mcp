import { APP_TIMEZONE } from "../config";
import type { Env } from "../env";
import type { Connection } from "../durable-objects/garmin-auth";
import { dateInZone, startSync } from "./sync";
import { repairArchives } from "./storage";
import { pruneSyncHistory } from "./sync-history";

export async function reconcileRuns(env: Env) {
  const rows = await env.DB.prepare(
    "SELECT id,workflow_id FROM sync_runs WHERE status IN ('queued','running') AND updated_at<? LIMIT 50",
  )
    .bind(new Date(Date.now() - 15 * 60_000).toISOString())
    .all<{ id: string; workflow_id: string }>();
  for (const run of rows.results) {
    try {
      const status = await (
        await env.SYNC_WORKFLOW.get(run.workflow_id)
      ).status();
      if (["errored", "terminated", "complete"].includes(status.status))
        await env.DB.prepare(
          "UPDATE sync_runs SET status='failed',error_code='WORKFLOW_INTERRUPTED',finished_at=?,updated_at=? WHERE id=? AND status IN ('queued','running')",
        )
          .bind(new Date().toISOString(), new Date().toISOString(), run.id)
          .run();
    } catch {
      /* Unknown state is not evidence of failure. Keep the stream lock. */
    }
  }
}
export async function runScheduled(env: Env, cron: string) {
  await reconcileRuns(env);
  await pruneSyncHistory(env);
  if (cron === "30 2 * * 0") await repairArchives(env);
  const rows = await env.DB.prepare(
    "SELECT c.* FROM provider_connections c LEFT JOIN owner_settings s ON s.user_id=c.user_id WHERE c.status='connected' AND COALESCE(s.auto_sync,1)=1",
  ).all<Connection>();
  const streams =
    cron === "*/30 * * * *"
      ? ["activities", "files"]
      : cron === "5 * * * *"
        ? ["health"]
        : cron === "15 2 * * *"
          ? ["training"]
          : ["devices"];
  for (const connection of rows.results) {
    const end = dateInZone(APP_TIMEZONE);
    for (const stream of streams) {
      if (stream === "training" && connection.auth_type === "personal_api")
        continue;
      const cursor = await env.DB.prepare(
        "SELECT checkpoint FROM sync_cursors WHERE connection_id=? AND stream=?",
      )
        .bind(connection.id, stream)
        .first<{ checkpoint: string }>();
      const overlap = stream === "health" ? 3 : 7;
      const start = new Date(
        Math.max(
          Date.parse(cursor?.checkpoint || end) - overlap * 86_400_000,
          Date.parse(end) - 365 * 86_400_000,
        ),
      )
        .toISOString()
        .slice(0, 10);
      try {
        await startSync(env, connection, stream, start, end);
      } catch {
        console.error(
          JSON.stringify({ event: "scheduled_sync_failed", stream }),
        );
      }
    }
  }
}
