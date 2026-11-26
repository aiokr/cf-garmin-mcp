import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { introspectWorkflow } from "cloudflare:test";
import { zipSync } from "fflate";
import { repairArchives } from "../apps/worker/src/services/storage";
import { env, fixture } from "./helpers";
import { syntheticFit } from "./fit-fixture";
import {
  seal,
  credentialFingerprint,
  sha256,
} from "../apps/worker/src/lib/crypto";
import {
  syncActivityPage,
  syncHealthDay,
  syncTrainingDay,
  archiveActivity,
  startSync,
} from "../apps/worker/src/services/sync";
import { parseFit, extractFit } from "../apps/worker/src/services/fit";
import {
  getActivity,
  activityDetails,
  activityPage,
} from "../apps/worker/src/services/queries";
import type { Connection } from "../apps/worker/src/durable-objects/garmin-auth";
let connection: Connection;
let activityId = "";
const activity = {
  activityId: 123,
  activityName: "Synthetic run",
  activityType: { typeKey: "running" },
  startTimeGMT: "2026-11-26 00:00:00",
  startTimeLocal: "2026-11-26 08:00:00",
  distance: 1000,
  duration: 300,
  averageSpeed: 3.33,
  averageHR: 121,
};
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
beforeAll(async () => {
  const { userId } = await fixture();
  const id = crypto.randomUUID();
  activityId = id + "_123";
  const encrypted = await seal(
    env,
    { userId, connectionId: id, region: "CN" },
    { accessToken: "synthetic-token", expiresAt: Date.now() + 3600_000 },
  );
  await env.DB.prepare(
    "INSERT INTO provider_connections(id,user_id,region,auth_type,external_user_id,display_name,status,encrypted_tokens,credential_fingerprint) VALUES (?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      userId,
      "CN",
      "personal_api",
      "42",
      "synthetic-owner",
      "connected",
      encrypted,
      await credentialFingerprint(env),
    )
    .run();
  connection = (await env.DB.prepare(
    "SELECT * FROM provider_connections WHERE id=?",
  )
    .bind(id)
    .first<Connection>())!;
  await env.DB.prepare("INSERT INTO owner_settings VALUES (?,90,365,0,0)")
    .bind(userId)
    .run();
});
afterEach(() => vi.restoreAllMocks());

describe.sequential(
  "persistent history, files and recoverable Workflows",
  () => {
    it("upserts repeated and edited activities without duplicates or cross-owner reads", async () => {
      let distance = 1000;
      vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        json([{ ...activity, distance }]),
      );
      await syncActivityPage(
        env,
        connection,
        "2026-11-20",
        "2026-11-26",
        0,
        true,
      );
      distance = 1200;
      await syncActivityPage(
        env,
        connection,
        "2026-11-20",
        "2026-11-26",
        0,
        true,
      );
      expect(
        (
          await env.DB.prepare("SELECT count(*) n FROM activities").first<{
            n: number;
          }>()
        )?.n,
      ).toBe(1);
      expect(
        (await getActivity(env, connection.user_id, activityId)).distance_m,
      ).toBe(1200);
      await expect(
        getActivity(env, "another-owner", activityId),
      ).rejects.toMatchObject({ code: "ACTIVITY_NOT_FOUND" });
      const page = await activityPage(env, connection.user_id, { limit: 1 });
      expect(page.items).toHaveLength(1);
      expect(page.nextCursor).toBeNull();
    });
    it("validates FIT CRC, ZIP extraction, units, laps and bounded track output inside Workers", async () => {
      const bytes = syntheticFit();
      const details = await parseFit(bytes);
      expect(details.samples).toHaveLength(3);
      expect(details.samples[0]?.speed_mps).toBe(3);
      expect(details.samples[0]?.hr_bpm).toBe(120);
      expect(details.laps[0]?.distance_m).toBe(200);
      expect(details.laps[0]?.duration_s).toBe(20);
      expect(details.track[0]?.[0]).toBeCloseTo(120, 5);
      expect(
        extractFit(new Uint8Array(zipSync({ "synthetic.fit": bytes }))),
      ).toEqual(bytes);
      const corrupt = new Uint8Array(bytes);
      corrupt[corrupt.length - 1] = corrupt.at(-1)! ^ 1;
      await expect(parseFit(corrupt)).rejects.toMatchObject({
        code: "FIT_INTEGRITY_FAILED",
      });
      expect((await parseFit(bytes, 1)).samples.length).toBeLessThanOrEqual(1);
    });
    it("never marks a failed R2 write ready and idempotently repairs the file on retry", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(
        async () => new Response(syntheticFit()),
      );
      const failed = {
        ...env,
        FIT_BUCKET: {
          put: async () => {
            throw new Error("synthetic R2 failure");
          },
        } as unknown as R2Bucket,
      };
      await expect(
        archiveActivity(failed, connection, activityId),
      ).rejects.toThrow();
      expect(
        (
          await env.DB.prepare(
            "SELECT status FROM activity_files WHERE activity_id=?",
          )
            .bind(activityId)
            .first()
        )?.status,
      ).toBe("error");
      await archiveActivity(env, connection, activityId);
      await archiveActivity(env, connection, activityId);
      const file = await env.DB.prepare(
        "SELECT status,r2_key,sha256 FROM activity_files WHERE activity_id=?",
      )
        .bind(activityId)
        .first<{ status: string; r2_key: string; sha256: string }>();
      expect(file?.status).toBe("ready");
      expect(file?.sha256).toBe(await sha256(syntheticFit()));
      expect((await env.FIT_BUCKET.list()).objects).toHaveLength(1);
      expect(
        (await activityDetails(env, connection.user_id, activityId))
          .sampleCount,
      ).toBe(3);
      await env.FIT_BUCKET.put(
        file!.r2_key,
        new Uint8Array(syntheticFit().length),
        { customMetadata: { sha256: file!.sha256 } },
      );
      await expect(
        activityDetails(env, connection.user_id, activityId),
      ).rejects.toMatchObject({ code: "FIT_INTEGRITY_FAILED" });
    });
    it("repairs an orphan object after the D1 index commit fails", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(
        async () => new Response(syntheticFit()),
      );
      await env.DB.prepare(
        "UPDATE activity_files SET status='pending',r2_key=NULL WHERE activity_id=?",
      )
        .bind(activityId)
        .run();
      const failedDb = {
        prepare(sql: string) {
          if (sql.includes("SET status='ready',r2_key"))
            return {
              bind: () => ({
                run: async () => {
                  throw new Error("synthetic D1 write failure");
                },
              }),
            };
          return env.DB.prepare(sql);
        },
      } as unknown as D1Database;
      await expect(
        archiveActivity({ ...env, DB: failedDb }, connection, activityId),
      ).rejects.toThrow();
      expect(
        (
          await env.DB.prepare(
            "SELECT status FROM activity_files WHERE activity_id=?",
          )
            .bind(activityId)
            .first()
        )?.status,
      ).toBe("error");
      expect((await repairArchives(env)).recovered).toBe(1);
      expect(
        (await activityDetails(env, connection.user_id, activityId))
          .sampleCount,
      ).toBe(3);
    });
    it("keeps true zeroes, records unavailable fields and maps health/training units", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes("dailySleepData"))
          return json({
            dailySleepDTO: {
              sleepTimeSeconds: 28800,
              sleepScores: { overall: { value: 88 } },
            },
          });
        if (url.includes("hrv-service"))
          return json({ hrvSummary: { lastNightAvg: 55 } });
        if (url.includes("usersummary"))
          return json({
            totalSteps: 0,
            restingHeartRate: 50,
            averageStressLevel: -1,
          });
        if (url.includes("trainingreadiness")) return json([{ score: 81 }]);
        if (url.includes("maxmet"))
          return json([{ generic: { vo2MaxPreciseValue: 52.7 } }]);
        if (url.includes("trainingstatus"))
          return json({
            mostRecentTrainingStatus: {
              latestTrainingStatusData: {
                device: {
                  trainingStatus: 2,
                  acuteTrainingLoadDTO: { dailyTrainingLoadAcute: 120 },
                },
              },
            },
          });
        throw new Error("Unexpected test upstream request");
      });
      await syncHealthDay(env, connection, "2026-11-26");
      await syncTrainingDay(env, connection, "2026-11-26");
      expect(
        await env.DB.prepare(
          "SELECT steps,sleep_seconds,hrv FROM daily_health",
        ).first(),
      ).toEqual({ steps: 0, sleep_seconds: 28800, hrv: 55 });
      expect(
        (await env.DB.prepare("SELECT stress FROM daily_health").first())
          ?.stress,
      ).toBeNull();
      expect(
        await env.DB.prepare(
          "SELECT vo2max,readiness,training_load FROM training_metrics",
        ).first(),
      ).toEqual({ vo2max: 52.7, readiness: 81, training_load: 120 });
      vi.mocked(fetch).mockImplementation(
        async () => new Response("", { status: 404 }),
      );
      expect(
        (await syncHealthDay(env, connection, "2026-11-26")).unavailable,
      ).toBe(true);
      expect(
        await env.DB.prepare(
          "SELECT steps,sleep_seconds,hrv FROM daily_health",
        ).first(),
      ).toEqual({ steps: 0, sleep_seconds: 28800, hrv: 55 });
    });
    it("runs a real Workflow, prevents duplicate active streams and advances checkpoints only on completed windows", async () => {
      const introspector = await introspectWorkflow(env.SYNC_WORKFLOW);
      await introspector.modifyAll(async (modifier) => {
        await modifier.disableSleeps();
        await modifier.disableRetryDelays();
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        await gate;
        return json({});
      });
      try {
        const first = await startSync(
          env,
          connection,
          "health",
          "2026-11-25",
          "2026-11-25",
        );
        const duplicate = await startSync(
          env,
          connection,
          "health",
          "2026-11-25",
          "2026-11-25",
        );
        expect(duplicate.id).toBe(first.id);
        expect(duplicate.existing).toBe(true);
        release();
        const instances = await introspector.get();
        expect(instances.length).toBe(1);
        await instances[0]!.waitForStatus("complete");
        expect(await instances[0]!.getOutput()).toMatchObject({
          status: "succeeded",
          count: 1,
        });
        expect(
          (
            await env.DB.prepare(
              "SELECT checkpoint FROM sync_cursors WHERE connection_id=? AND stream='health'",
            )
              .bind(connection.id)
              .first()
          )?.checkpoint,
        ).toBe("2026-11-25");
      } finally {
        release();
        await introspector.dispose();
      }
    });
    it("does not advance a cursor after exhausted rate-limit retries", async () => {
      const introspector = await introspectWorkflow(env.SYNC_WORKFLOW);
      await introspector.modifyAll(async (modifier) => {
        await modifier.disableSleeps();
        await modifier.disableRetryDelays();
      });
      vi.spyOn(globalThis, "fetch").mockImplementation(
        async () =>
          new Response("", { status: 429, headers: { "Retry-After": "120" } }),
      );
      try {
        await startSync(env, connection, "health", "2026-11-26", "2026-11-26");
        const instances = await introspector.get();
        await instances[0]!.waitForStatus("complete");
        expect(await instances[0]!.getOutput()).toMatchObject({
          status: "failed",
          code: "UPSTREAM_RATE_LIMITED",
        });
        expect(
          (
            await env.DB.prepare(
              "SELECT checkpoint FROM sync_cursors WHERE connection_id=? AND stream='health'",
            )
              .bind(connection.id)
              .first()
          )?.checkpoint,
        ).toBe("2026-11-25");
      } finally {
        await introspector.dispose();
      }
    });
  },
);
