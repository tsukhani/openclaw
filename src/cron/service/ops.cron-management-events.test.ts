import { describe, expect, it, vi } from "vitest";
import { setBaseDirForTests, setEnabledForTests } from "../../unified-events/integrations.js";
import { queryEvents, resetEventIdCountersForTests } from "../../unified-events/store.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../service.test-harness.js";
import type { CronJob } from "../types.js";
import { add, remove, update } from "./ops.js";
import { createCronServiceState } from "./state.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-mgmt-events",
});

function createTestJob(now: number, overrides?: Partial<CronJob>): CronJob {
  return {
    id: "test-job-1",
    name: "test job",
    enabled: true,
    createdAtMs: now - 60_000,
    updatedAtMs: now - 60_000,
    schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "do work" },
    sessionKey: "agent:main:main",
    state: { nextRunAtMs: now + 3_600_000 },
    ...overrides,
  };
}

describe("cron management event emission", () => {
  let eventsDir: string;

  it("emits cron-management event on add", async () => {
    const { storePath } = await makeStorePath();
    eventsDir = storePath.replace(/\/cron\/jobs\.json$/, "");

    resetEventIdCountersForTests();
    setBaseDirForTests(eventsDir);
    setEnabledForTests(true);

    try {
      const now = Date.parse("2026-03-23T12:00:00.000Z");
      const state = createCronServiceState({
        storePath,
        cronEnabled: true,
        log: logger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeatNow: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      });

      const job = await add(state, {
        name: "new-cron-job",
        enabled: true,
        schedule: { kind: "cron", expr: "*/5 * * * *", tz: "UTC" },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "hello" },
        sessionKey: "agent:main:main",
      });

      await vi.waitFor(async () => {
        const page = await queryEvents(eventsDir, "agent:main:main");
        expect(page.total).toBe(1);
      });

      const page = await queryEvents(eventsDir, "agent:main:main");
      const event = page.events[0];
      expect(event.kind).toBe("cron-management");
      if (event.kind === "cron-management") {
        expect(event.jobId).toBe(job.id);
        expect(event.jobName).toBe("new-cron-job");
        expect(event.operation).toBe("add");
        expect(event.enabled).toBe(true);
        expect(event.schedule).toMatchObject({ kind: "cron", expr: "*/5 * * * *" });
        expect(typeof event.nextRunAtMs).toBe("number");
      }

      if (state.timer) {
        clearTimeout(state.timer);
      }
    } finally {
      setBaseDirForTests(undefined);
      setEnabledForTests(undefined);
    }
  });

  it("emits cron-management event on update", async () => {
    const { storePath } = await makeStorePath();
    eventsDir = storePath.replace(/\/cron\/jobs\.json$/, "");

    resetEventIdCountersForTests();
    setBaseDirForTests(eventsDir);
    setEnabledForTests(true);

    try {
      const now = Date.parse("2026-03-23T12:00:00.000Z");
      const job = createTestJob(now);
      await writeCronStoreSnapshot({ storePath, jobs: [job] });

      const state = createCronServiceState({
        storePath,
        cronEnabled: true,
        log: logger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeatNow: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      });

      await update(state, "test-job-1", { enabled: false });

      await vi.waitFor(async () => {
        const page = await queryEvents(eventsDir, "agent:main:main");
        expect(page.total).toBe(1);
      });

      const page = await queryEvents(eventsDir, "agent:main:main");
      const event = page.events[0];
      expect(event.kind).toBe("cron-management");
      if (event.kind === "cron-management") {
        expect(event.jobId).toBe("test-job-1");
        expect(event.operation).toBe("update");
        expect(event.enabled).toBe(false);
      }

      if (state.timer) {
        clearTimeout(state.timer);
      }
    } finally {
      setBaseDirForTests(undefined);
      setEnabledForTests(undefined);
    }
  });

  it("emits cron-management event on remove", async () => {
    const { storePath } = await makeStorePath();
    eventsDir = storePath.replace(/\/cron\/jobs\.json$/, "");

    resetEventIdCountersForTests();
    setBaseDirForTests(eventsDir);
    setEnabledForTests(true);

    try {
      const now = Date.parse("2026-03-23T12:00:00.000Z");
      const job = createTestJob(now);
      await writeCronStoreSnapshot({ storePath, jobs: [job] });

      const state = createCronServiceState({
        storePath,
        cronEnabled: true,
        log: logger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeatNow: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      });

      const result = await remove(state, "test-job-1");
      expect(result).toEqual({ ok: true, removed: true });

      await vi.waitFor(async () => {
        const page = await queryEvents(eventsDir, "agent:main:main");
        expect(page.total).toBe(1);
      });

      const page = await queryEvents(eventsDir, "agent:main:main");
      const event = page.events[0];
      expect(event.kind).toBe("cron-management");
      if (event.kind === "cron-management") {
        expect(event.jobId).toBe("test-job-1");
        expect(event.jobName).toBe("test job");
        expect(event.operation).toBe("remove");
      }

      if (state.timer) {
        clearTimeout(state.timer);
      }
    } finally {
      setBaseDirForTests(undefined);
      setEnabledForTests(undefined);
    }
  });

  it("does not emit cron-management event when remove finds no job", async () => {
    const { storePath } = await makeStorePath();
    eventsDir = storePath.replace(/\/cron\/jobs\.json$/, "");

    resetEventIdCountersForTests();
    setBaseDirForTests(eventsDir);
    setEnabledForTests(true);

    try {
      const now = Date.parse("2026-03-23T12:00:00.000Z");
      await writeCronStoreSnapshot({ storePath, jobs: [] });

      const state = createCronServiceState({
        storePath,
        cronEnabled: true,
        log: logger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeatNow: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      });

      const result = await remove(state, "nonexistent-job");
      expect(result).toEqual({ ok: true, removed: false });

      // Flush any pending microtasks (no setTimeout — fake timers are active).
      await vi.advanceTimersByTimeAsync(100);

      // Events dir may not exist yet if no events were written.
      const page = await queryEvents(eventsDir, "cron:nonexistent-job").catch(
        () => ({ total: 0 }) as { total: number },
      );
      expect(page.total).toBe(0);

      if (state.timer) {
        clearTimeout(state.timer);
      }
    } finally {
      setBaseDirForTests(undefined);
      setEnabledForTests(undefined);
    }
  });
});
