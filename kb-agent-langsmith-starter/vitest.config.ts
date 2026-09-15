import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Mirrors tsconfig's "@/*" paths so route handlers can be imported in tests.
  resolve: { alias: { "@": path.resolve(import.meta.dirname, ".") } },
  test: {
    // The eve dev server snapshots the whole project under .eve/dev-runtime/
    // while running — without this exclude, vitest re-runs stale copies of the
    // test suite from those snapshots (and they fail on divergent state).
    exclude: ["**/node_modules/**", "**/.eve/**"],
  },
});
