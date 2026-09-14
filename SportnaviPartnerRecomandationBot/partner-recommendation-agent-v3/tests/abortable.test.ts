import { describe, expect, it } from "vitest";
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
});
