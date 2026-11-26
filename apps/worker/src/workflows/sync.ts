import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import type { Env } from "../env";
import type { Connection } from "../durable-objects/garmin-auth";
import {
  archiveActivity,
  daysBetween,
  syncActivityPage,
  syncHealthDay,
  syncTrainingDay,
  syncDevicesRecords,
  startSync,
} from "../services/sync";
import { ServiceError, safeCode } from "../lib/errors";

type Run = {
  id: string;
  connection_id: string;
  stream: string;
  start_date: string;
  end_date: string;
  status: string;
  initial_sync: number;
};
export class SyncWorkflow extends WorkflowEntrypoint<Env, { runId: string }> {
  async run(event: WorkflowEvent<{ runId: string }>, step: WorkflowStep) {
    const run = await step.do("load-run", async () => {
      const value = await this.env.DB.prepare(
        "SELECT * FROM sync_runs WHERE id=?",
      )
        .bind(event.payload.runId)
        .first<Run>();
      if (!value) throw new Error("SYNC_RUN_NOT_FOUND");
      return value;
    });
    if (["cancelled", "succeeded"].includes(run.status))
      return { status: run.status };
    let count = 0;
    let partial = false;
    try {
      await step.do("mark-running", () =>
        this.env.DB.prepare(
          "UPDATE sync_runs SET status='running',updated_at=? WHERE id=? AND status='queued'",
        )
          .bind(new Date().toISOString(), run.id)
          .run()
          .then(() => true),
      );
      const row = await step.do("resolve-connection", async () => {
        const connection = await this.env.DB.prepare(
          "SELECT * FROM provider_connections WHERE id=? AND status=?",
        )
          .bind(run.connection_id, "connected")
          .first<Connection>();
        if (!connection) throw new Error("CONNECTION_DISABLED");
        return connection;
      });
      const settings = await step.do("settings", () =>
        this.env.DB.prepare("SELECT * FROM owner_settings WHERE user_id=?")
          .bind(row.user_id)
          .first<{
            archive_fit: number;
            health_history_days: number;
            activity_history_days: number;
          }>(),
      );
      if (run.stream === "activities") {
        let completed = false;
        for (let offset = 0; offset < 200_000; offset += 50) {
          const page = await this.perform(
            step,
            `activities-${offset}`,
            row,
            run,
            () =>
              syncActivityPage(
                this.env,
                row,
                run.start_date,
                run.end_date,
                offset,
                settings?.archive_fit !== 0,
              ),
          );
          count += page.count;
          if (!page.hasMore) {
            completed = true;
            break;
          }
        }
        if (!completed) throw new ServiceError("SYNC_PAGINATION_LIMIT", 413);
      } else if (run.stream === "files") {
        const files = await step.do("pending-files", () =>
          this.env.DB.prepare(
            "SELECT f.activity_id FROM activity_files f JOIN activities a ON a.id=f.activity_id WHERE a.connection_id=? AND f.status<>'ready' ORDER BY a.start_time_utc DESC LIMIT 200",
          )
            .bind(row.id)
            .all<{ activity_id: string }>()
            .then((result) => result.results),
        );
        for (const file of files) {
          try {
            await this.perform(
              step,
              `file-${file.activity_id}`,
              row,
              run,
              async () => {
                await archiveActivity(this.env, row, file.activity_id);
                return true;
              },
            );
            count++;
          } catch (error) {
            if (
              error instanceof ServiceError &&
              [
                "CONNECTION_DISABLED",
                "SYNC_CANCELLED",
                "PROVIDER_REAUTH_REQUIRED",
              ].includes(error.code)
            )
              throw error;
            partial = true;
          }
        }
        const remaining = await step.do("remaining-files", () =>
          this.env.DB.prepare(
            "SELECT count(*) n FROM activity_files f JOIN activities a ON a.id=f.activity_id WHERE a.connection_id=? AND f.status<>'ready'",
          )
            .bind(row.id)
            .first<{ n: number }>(),
        );
        partial ||= Boolean(remaining?.n);
      } else if (run.stream === "devices") {
        count += (
          await this.perform(step, "devices-records", row, run, () =>
            syncDevicesRecords(this.env, row, run.end_date),
          )
        ).count;
      } else {
        for (const date of daysBetween(run.start_date, run.end_date)) {
          const result = await this.perform(
            step,
            `${run.stream}-${date}`,
            row,
            run,
            () =>
              run.stream === "health"
                ? syncHealthDay(this.env, row, date)
                : syncTrainingDay(this.env, row, date),
          );
          count += result.count;
          partial ||= result.unavailable;
        }
      }
      await step.do("commit-checkpoint", async () => {
        const now = new Date().toISOString();
        const status = await this.env.DB.prepare(
          "SELECT status FROM sync_runs WHERE id=?",
        )
          .bind(run.id)
          .first<{ status: string }>();
        if (status?.status === "cancelled")
          throw new ServiceError("SYNC_CANCELLED", 409);
        const statements: D1PreparedStatement[] = [];
        // Unsupported metrics do not prevent a completed date window checkpoint.
        if (run.stream !== "files" || !partial)
          statements.push(
            this.env.DB.prepare(
              "INSERT INTO sync_cursors SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM sync_runs r JOIN provider_connections c ON c.id=r.connection_id WHERE r.id=? AND r.status='running' AND c.status='connected') ON CONFLICT(connection_id,stream) DO UPDATE SET checkpoint=MAX(checkpoint,excluded.checkpoint),last_success_at=excluded.last_success_at",
            ).bind(row.id, run.stream, run.end_date, now, run.id),
          );
        statements.push(
          this.env.DB.prepare(
            "UPDATE provider_connections SET last_synced_at=? WHERE id=? AND status='connected' AND EXISTS(SELECT 1 FROM sync_runs WHERE id=? AND status='running')",
          ).bind(now, row.id, run.id),
        );
        statements.push(
          this.env.DB.prepare(
            "UPDATE sync_runs SET status=?,counts=?,finished_at=?,updated_at=?,error_code=? WHERE id=? AND status='running'",
          ).bind(
            partial ? "partial" : "succeeded",
            count,
            now,
            now,
            partial ? "PARTIAL_DATA" : null,
            run.id,
          ),
        );
        await this.env.DB.batch(statements);
        return true;
      });
      if (run.stream === "activities" && settings?.archive_fit !== 0)
        await step.do("queue-fit", () =>
          startSync(this.env, row, "files", run.start_date, run.end_date).catch(
            () => ({ queued: false }),
          ),
        );
      if (
        run.initial_sync &&
        ["activities", "health", "training"].includes(run.stream)
      ) {
        const days =
          run.stream === "activities"
            ? settings?.activity_history_days || 365
            : settings?.health_history_days || 90;
        const start = new Date(
          Date.parse(run.end_date) - (days - 1) * 86400_000,
        )
          .toISOString()
          .slice(0, 10);
        const end = new Date(Date.parse(run.start_date) - 86400_000)
          .toISOString()
          .slice(0, 10);
        if (start <= end)
          await step.do("queue-history", () =>
            startSync(this.env, row, run.stream, start, end, "backfill").catch(
              () => ({ queued: false }),
            ),
          );
      }
      return { status: partial ? "partial" : "succeeded", count };
    } catch (error) {
      await step.do("mark-failed", async () => {
        const now = new Date().toISOString();
        await this.env.DB.prepare(
          "UPDATE sync_runs SET status=?,counts=?,error_code=?,finished_at=?,updated_at=? WHERE id=?",
        )
          .bind(
            error instanceof ServiceError && error.code === "SYNC_CANCELLED"
              ? "cancelled"
              : "failed",
            count,
            safeCode(error),
            now,
            now,
            run.id,
          )
          .run();
        return true;
      });
      return { status: "failed", code: safeCode(error), count };
    }
  }

  private async perform<T>(
    step: WorkflowStep,
    name: string,
    connection: Connection,
    run: Run,
    operation: () => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await step.do(`${name}-${attempt}`, async () => {
        const status = await this.env.DB.prepare(
          "SELECT c.status, r.status AS run_status FROM provider_connections c JOIN sync_runs r ON r.connection_id=c.id WHERE c.id=? AND r.id=?",
        )
          .bind(connection.id, run.id)
          .first<{ status: string; run_status: string }>();
        if (status?.run_status === "cancelled")
          return {
            ok: false as const,
            code: "SYNC_CANCELLED",
            status: 409,
            retryAfter: 0,
          };
        if (status?.status !== "connected")
          return {
            ok: false as const,
            code: "CONNECTION_DISABLED",
            status: 409,
            retryAfter: 0,
          };
        try {
          const value = await operation();
          await this.env.DB.prepare(
            "UPDATE sync_runs SET updated_at=? WHERE id=?",
          )
            .bind(new Date().toISOString(), run.id)
            .run();
          return { ok: true as const, value: JSON.stringify(value) };
        } catch (error) {
          return {
            ok: false as const,
            code: safeCode(error),
            status: error instanceof ServiceError ? error.status : 500,
            retryAfter: error instanceof ServiceError ? error.retryAfter : 0,
          };
        }
      });
      if (result.ok) return JSON.parse(result.value) as T;
      if (
        attempt === 2 ||
        ![
          "UPSTREAM_RATE_LIMITED",
          "UPSTREAM_NETWORK_ERROR",
          "UPSTREAM_UNAVAILABLE",
          "INTERNAL_ERROR",
        ].includes(result.code)
      )
        throw new ServiceError(result.code, result.status, result.retryAfter);
      await step.sleep(
        `${name}-backoff-${attempt}`,
        `${Math.max(result.retryAfter, 30 * 2 ** attempt)} seconds`,
      );
    }
    throw new ServiceError("SYNC_RETRY_EXHAUSTED", 502);
  }
}
