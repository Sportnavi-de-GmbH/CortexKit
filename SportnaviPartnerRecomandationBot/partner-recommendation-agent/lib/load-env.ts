/**
 * load-env.ts — loads .env.local (then .env) from the project root into
 * process.env for scripts run outside the eve runtime (tsx scripts, smoke
 * tests). `import "dotenv/config"` alone only reads `.env`, which this
 * project intentionally does not use — secrets live in `.env.local`.
 *
 * Import this FIRST in any script entry point:
 *   import "../lib/load-env";
 */
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";

// This module may be bundled (e.g. into eve's .eve/dev-hosts build output),
// so import.meta.url is not a reliable anchor for the project root. Walk up
// from BOTH the module location and process.cwd() until a directory
// containing .env.local (or package.json as a fallback stop) is found.
function findEnvFile(startDir: string): string | undefined {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, ".env.local"))) return path.join(dir, ".env.local");
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

const candidates = [
  findEnvFile(process.cwd()),
  findEnvFile(path.dirname(fileURLToPath(import.meta.url))),
].filter((p): p is string => typeof p === "string");

if (candidates.length > 0) {
  config({ path: [...new Set(candidates)], quiet: true });
}
