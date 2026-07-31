import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The eve dev server snapshots the whole project under .eve/dev-runtime/
    // while running — without this exclude, vitest re-runs stale copies of the
    // test suite from those snapshots (and they fail on divergent state).
    exclude: ["**/node_modules/**", "**/.eve/**"],
  },
});
