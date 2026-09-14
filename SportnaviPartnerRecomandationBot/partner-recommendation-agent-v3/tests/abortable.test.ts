import { describe, expect, it, vi } from "vitest";
import { raceAbort } from "../lib/abortable";

describe("raceAbort", () => {
  it("resolves normally when the promise settles first", async () => {
    const controller = new AbortController();
    await expect(raceAbort(Promise.resolve("ok"), controller.signal, "test")).resolves.toBe("ok");
  });

  it("rejects with a timeout message when the signal times out before the promise settles", async () => {
    const neverSettles = new Promise(() => {});
    await expect(raceAbort(neverSettles, AbortSignal.timeout(10), "test")).rejects.toThrow(/aborted: timeout/);
  });

  it("rejects immediately for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort(new Error("nope"));
    await expect(raceAbort(new Promise(() => {}), controller.signal, "test")).rejects.toThrow(/aborted: nope/);
  });

  it("observes a callee's late rejection on an already-aborted signal without an unhandled rejection", async () => {
    const controller = new AbortController();
    controller.abort(new Error("nope"));
    const lateRejecting = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("callee blew up")), 5);
    });

    const spy = vi.fn();
    process.on("unhandledRejection", spy);
    try {
      await expect(raceAbort(lateRejecting, controller.signal, "test")).rejects.toThrow(/aborted/);
      await new Promise((r) => setTimeout(r, 20));
      expect(spy).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", spy);
    }
  });

  it("observes a callee's late rejection when the signal aborts before the callee settles, without an unhandled rejection", async () => {
    const controller = new AbortController();
    const lateRejecting = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("callee blew up")), 5);
    });

    const spy = vi.fn();
    process.on("unhandledRejection", spy);
    try {
      const result = raceAbort(lateRejecting, controller.signal, "test");
      controller.abort(new Error("nope"));
      await expect(result).rejects.toThrow(/aborted/);
      await new Promise((r) => setTimeout(r, 20));
      expect(spy).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", spy);
    }
  });
});
