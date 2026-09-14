/**
 * Defence in depth — callees are handed the signal, but a callee that
 * ignores it must not be able to hang a stage.
 *
 * Contrast with `withTimeout()` in `lib/reused/timeout.ts`: that one only
 * knows a fixed ms deadline and ignores the run's own AbortSignal, so it
 * can't be cancelled early by anything upstream — `raceAbort` races the
 * actual signal instead.
 */
export function raceAbort<T>(p: Promise<T>, signal: AbortSignal, label: string): Promise<T> {
  function reasonText(): string {
    const reason = signal.reason as { name?: string; message?: string } | undefined;
    if (reason?.name === "TimeoutError") return "timeout";
    return String(reason?.message ?? reason ?? "aborted");
  }

  if (signal.aborted) {
    // The signal already fired, but `p` is a real promise that may still
    // reject later (e.g. a callee that itself observes the abort and
    // rejects a few ms after). Observe that rejection so it can never
    // become an unhandled rejection and crash the process (Node 24).
    p.catch(() => {});
    return Promise.reject(new Error(`${label} aborted: ${reasonText()}`));
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new Error(`${label} aborted: ${reasonText()}`));
      // The abort path already won the race; `p` may still reject later
      // (once the callee itself notices the same signal) and that
      // rejection would otherwise never be observed.
      p.catch(() => {});
    };
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}
