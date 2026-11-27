import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../apps/worker/src/env";
import { runScheduled } from "../apps/worker/src/services/scheduler";
import { startSync } from "../apps/worker/src/services/sync";
import { repairArchives } from "../apps/worker/src/services/storage";

vi.mock("../apps/worker/src/services/sync", () => ({
  dateInZone: () => "2026-11-29",
  startSync: vi.fn(async () => {}),
}));
vi.mock("../apps/worker/src/services/storage", () => ({
  repairArchives: vi.fn(async () => {}),
}));
vi.mock("../apps/worker/src/services/sync-history", () => ({
  pruneSyncHistory: vi.fn(async () => {}),
}));

function schedulerEnv(authType = "credentials") {
  const prepare = vi.fn((sql: string) => {
    const statement = {
      bind: vi.fn(() => statement),
      all: vi.fn(async () => ({
        results: sql.includes("FROM provider_connections")
          ? [{ id: "connection", auth_type: authType }]
          : [],
      })),
      first: vi.fn(async () => null),
    };
    return statement;
  });
  return { DB: { prepare } } as unknown as Env;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

describe("single-cron scheduler", () => {
  it.each([
    ["2026-11-27T01:00:00Z", ["activities", "files"], false],
    ["2026-11-27T01:30:00Z", ["activities", "files"], false],
    ["2026-11-27T01:05:00Z", ["health"], false],
    ["2026-11-27T02:05:00Z", ["health"], false],
    ["2026-11-27T02:15:00Z", ["training"], false],
    ["2026-11-27T03:15:00Z", [], false],
    ["2026-11-28T02:30:00Z", ["activities", "files"], false],
    ["2026-11-29T02:30:00Z", ["activities", "files", "devices"], true],
    ["2026-11-29T03:30:00Z", ["activities", "files"], false],
    // Sunday in Shanghai is still Saturday UTC; maintenance must not run yet.
    ["2026-11-29T02:30:00+08:00", ["activities", "files"], false],
  ] as const)("dispatches the UTC slot %s", async (time, streams, repair) => {
    // Actual delivery happens later, on a different day and outside the due slot.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-12-01T10:47:00Z"));
    const env = schedulerEnv();
    await runScheduled(env, Date.parse(time));
    expect(vi.mocked(startSync).mock.calls.map((call) => call[2])).toEqual(
      streams,
    );
    expect(repairArchives).toHaveBeenCalledTimes(repair ? 1 : 0);
    if (!streams.length) expect(env.DB.prepare).not.toHaveBeenCalled();
  });

  it("skips unsupported Personal API training", async () => {
    await runScheduled(
      schedulerEnv("personal_api"),
      Date.parse("2026-11-27T02:15:00Z"),
    );
    expect(startSync).not.toHaveBeenCalled();
  });
});
