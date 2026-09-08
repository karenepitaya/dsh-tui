import { afterEach, describe, expect, it, vi } from "vitest";
import { MotionHost } from "../src/index.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("MotionHost", () => {
  it("shares one timer across every active component", () => {
    vi.useFakeTimers();
    const requestRender = vi.fn();
    const host = new MotionHost(requestRender, { motion: "full", glyphs: "ascii", isTTY: true });
    const leases = Array.from({ length: 100 }, (_, index) => host.retain(index === 0 ? 80 : 120));

    expect(vi.getTimerCount()).toBe(1);
    expect(requestRender).toHaveBeenCalledTimes(100);
    vi.advanceTimersByTime(80);
    expect(requestRender).toHaveBeenCalledTimes(101);

    leases[0]?.release();
    expect(vi.getTimerCount()).toBe(1);
    for (const lease of leases.slice(1)) lease.release();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not create a timer in reduced-motion mode", () => {
    vi.useFakeTimers();
    const host = new MotionHost(() => {}, { motion: "reduced", isTTY: true });
    const lease = host.retain(80);
    expect(vi.getTimerCount()).toBe(0);
    expect(lease.released).toBe(false);
    lease.release();
    expect(lease.released).toBe(true);
  });

  it("expires a finite lease from the same shared timer", () => {
    vi.useFakeTimers();
    let now = 0;
    const onExpire = vi.fn();
    const host = new MotionHost(() => {}, {
      motion: "full",
      isTTY: true,
      now: () => now,
    });
    const lease = host.retain(50, { expiresAt: 120, onExpire });

    expect(vi.getTimerCount()).toBe(1);
    now = 120;
    vi.advanceTimersByTime(50);

    expect(onExpire).toHaveBeenCalledOnce();
    expect(lease.released).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    host.dispose();
  });

  it("cleans up permanently when disposed", () => {
    vi.useFakeTimers();
    const host = new MotionHost(() => {}, { motion: "full", isTTY: true });
    host.retain(80);
    host.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(() => host.retain(80)).toThrow(/disposed/u);
  });
});
