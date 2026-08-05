/**
 * Shared test fakes for lib/partners/* unit tests. Not a *.test.ts file, so
 * vitest's `tests/**\/*.test.ts` include pattern skips it.
 */
import { vi } from "vitest";

/**
 * A minimal thenable query-builder stand-in for supabase-js's
 * PostgrestFilterBuilder: every chained method call (`.select()`, `.eq()`,
 * `.in()`, `.overlaps()`, `.not()`, ...) returns the same object, and
 * `await`-ing it resolves to the fixed `result`.
 */
export function chainable<T>(
  result: T | Promise<T>,
  onCall?: (method: string, args: unknown[]) => void,
): T & Record<string, (...args: unknown[]) => unknown> {
  const proxy: any = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") {
          // Promise.resolve() unwraps whether `result` is a plain value (the
          // common case) or itself a Promise (e.g. fakeSupabase's rpc()
          // computing its result asynchronously) — either way `await proxy`
          // behaves exactly like awaiting the real PostgrestFilterBuilder.
          return (resolve: (v: T) => void, reject?: (e: unknown) => void) =>
            Promise.resolve(result).then(resolve, reject);
        }
        if (prop === "catch" || prop === "finally") {
          return () => proxy;
        }
        return (...args: unknown[]) => {
          onCall?.(String(prop), args);
          return proxy;
        };
      },
    },
  );
  return proxy;
}

/**
 * A fake Supabase client whose `.from(table)` and `.rpc(name)` are backed by
 * lookup maps of canned results, with call-tracking spies. `methodCalls`
 * records every chained method (`.eq`, `.overlaps`, `.not`, ...) invoked per
 * table, in order, across all `.from(table)` calls.
 */
export function fakeSupabase(opts: {
  from?: Record<string, unknown>;
  rpc?: Record<string, unknown | ((args: unknown) => unknown)>;
}) {
  const fromCalls: string[] = [];
  const rpcCalls: Array<{ name: string; args: unknown }> = [];
  const methodCalls: Array<{ table: string; method: string; args: unknown[] }> = [];

  const from = vi.fn((table: string) => {
    fromCalls.push(table);
    return chainable(opts.from?.[table] ?? { data: [], error: null }, (method, args) => {
      methodCalls.push({ table, method, args });
    });
  });

  // Returns a `chainable()` proxy, not a bare Promise, so production code
  // that does `supabase.rpc(...).abortSignal(signal)` (Supabase's real
  // PostgrestFilterBuilder supports this — see lib/timeout.ts's callers)
  // works against the fake too. `await`-ing the proxy still resolves to the
  // same result as before; `rpcCalls` is still recorded synchronously on
  // the call itself, not on resolution.
  const rpc = vi.fn((name: string, args: unknown) => {
    rpcCalls.push({ name, args });
    const resultPromise = (async () => {
      const entry = opts.rpc?.[name];
      if (typeof entry === "function") {
        return (entry as (args: unknown) => unknown)(args);
      }
      return entry ?? { data: [], error: null };
    })();
    return chainable(resultPromise, (method, callArgs) => {
      methodCalls.push({ table: name, method, args: callArgs });
    });
  });

  return { from, rpc, fromCalls, rpcCalls, methodCalls } as any;
}
