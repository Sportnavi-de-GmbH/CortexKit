import { describe, expect, it } from "vitest";
import { TimeoutError, withTimeout, timeoutSignal } from "../lib/timeout";

describe("withTimeout", () => {
  it("resolves with the promise's value when it settles before the deadline", async () => {
    const result = await withTimeout(Promise.resolve("ok"), 50, "fast");
    expect(result).toBe("ok");
  });

  it("rejects with a TimeoutError when the promise doesn't settle in time", async () => {
    const never = new Promise<string>(() => {});
    await expect(withTimeout(never, 10, "slow-stage")).rejects.toThrow(TimeoutError);
    await expect(withTimeout(never, 10, "slow-stage")).rejects.toThrow(/slow-stage exceeded 10ms/);
  });

  it("propagates the original rejection when the promise rejects before the deadline", async () => {
    const failing = Promise.reject(new Error("boom"));
    await expect(withTimeout(failing, 50, "fails-fast")).rejects.toThrow("boom");
  });
});

describe("timeoutSignal", () => {
  it("returns an AbortSignal that is not aborted immediately", () => {
    const signal = timeoutSignal(1000);
    expect(signal.aborted).toBe(false);
  });

  it("aborts once the timeout elapses", async () => {
    const signal = timeoutSignal(5);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(signal.aborted).toBe(true);
  });
});
