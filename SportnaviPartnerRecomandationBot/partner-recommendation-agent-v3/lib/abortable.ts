/**
 * Defence in depth — callees are handed the signal, but a callee that
 * ignores it must not be able to hang a stage.
 */
export function raceAbort<T>(p: Promise<T>, signal: AbortSignal, label: string): Promise<T> {
  function reasonText(): string {
    const reason = signal.reason as { name?: string; message?: string } | undefined;
    if (reason?.name === "TimeoutError") return "timeout";
    return String(reason?.message ?? reason ?? "aborted");
  }

  if (signal.aborted) {
    return Promise.reject(new Error(`${label} aborted: ${reasonText()}`));
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new Error(`${label} aborted: ${reasonText()}`));
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
