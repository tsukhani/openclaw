import { describe, it, expect, beforeEach } from "vitest";
import { MemoryMetrics } from "./metrics.js";

describe("MemoryMetrics", () => {
  let m: MemoryMetrics;

  beforeEach(() => {
    m = new MemoryMetrics();
  });

  describe("record()", () => {
    it("starts at zero and increments by 1 by default", () => {
      m.record("memories_stored");
      expect(m.snapshot().memories_stored).toBe(1);
    });

    it("increments by the given value", () => {
      m.record("memories_stored", 5);
      expect(m.snapshot().memories_stored).toBe(5);
    });

    it("accumulates across multiple calls", () => {
      m.record("memories_stored");
      m.record("memories_stored", 3);
      expect(m.snapshot().memories_stored).toBe(4);
    });

    it("tracks independent counters separately", () => {
      m.record("memories_stored", 2);
      m.record("memories_deduped", 7);
      const snap = m.snapshot();
      expect(snap.memories_stored).toBe(2);
      expect(snap.memories_deduped).toBe(7);
    });
  });

  describe("recordDuration()", () => {
    it("records a positive elapsed duration", () => {
      const before = Date.now() - 50; // simulate 50ms+ already elapsed
      m.recordDuration("sleep_cycle_duration_ms", before);
      const snap = m.snapshot();
      expect(snap.sleep_cycle_duration_ms).toBeGreaterThanOrEqual(50);
    });

    it("accumulates duration across multiple calls", () => {
      const t1 = Date.now() - 100;
      const t2 = Date.now() - 200;
      m.recordDuration("sleep_cycle_duration_ms", t1);
      m.recordDuration("sleep_cycle_duration_ms", t2);
      const snap = m.snapshot();
      // 100ms + 200ms ≈ 300ms (allow some wall-clock slack)
      expect(snap.sleep_cycle_duration_ms).toBeGreaterThanOrEqual(300);
    });
  });

  describe("snapshot()", () => {
    it("returns an empty object when no metrics recorded", () => {
      expect(m.snapshot()).toEqual({});
    });

    it("returns all recorded counters", () => {
      m.record("memories_stored", 3);
      m.record("phase_errors", 1);
      m.record("sleep_cycles_run", 2);
      const snap = m.snapshot();
      expect(snap).toEqual({ memories_stored: 3, phase_errors: 1, sleep_cycles_run: 2 });
    });

    it("returns a copy — mutations do not affect internal state", () => {
      m.record("memories_stored", 1);
      const snap = m.snapshot();
      snap.memories_stored = 999;
      expect(m.snapshot().memories_stored).toBe(1);
    });
  });

  describe("reset()", () => {
    it("clears all counters", () => {
      m.record("memories_stored", 5);
      m.record("memories_deduped", 3);
      m.reset();
      expect(m.snapshot()).toEqual({});
    });

    it("allows recording after reset", () => {
      m.record("memories_stored", 5);
      m.reset();
      m.record("memories_stored", 2);
      expect(m.snapshot().memories_stored).toBe(2);
    });
  });
});
