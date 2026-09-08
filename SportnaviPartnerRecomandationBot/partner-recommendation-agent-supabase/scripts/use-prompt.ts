/**
 * Switch which FAQ system prompt is live.
 *
 *   npm run prompt:use          # show which version is active
 *   npm run prompt:use v1       # activate the pre-buttons prompt (rollback)
 *   npm run prompt:use v2       # activate the action-button prompt
 *
 * WHY A COPY AND NOT A CONFIG FLAG: eve resolves the system prompt purely by
 * filesystem convention — it reads `agent/instructions.md` at BUILD time and
 * `defineAgent()` rejects an `instructions` key outright (its options type is
 * exact, so an extra key is a type error, not an ignored field). So the only
 * way to pick a prompt is to decide which bytes sit in `agent/instructions.md`.
 *
 * The authored versions live in `agent/prompts/instructions-<version>.md`;
 * `agent/instructions.md` is the ACTIVE COPY. Edit the version file, then re-run
 * this script — never hand-edit `agent/instructions.md`, that edit is what the
 * next switch overwrites.
 *
 * Keeping it a plain static file also preserves Azure prompt caching: the
 * ~16.7k-token prefix stays byte-identical across every turn (CLAUDE.md §9).
 */
import { copyFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PROMPTS_DIR = "agent/prompts";
const ACTIVE = "agent/instructions.md";

/** `instructions-v2.md` → `v2`; anything else is not a version file. */
function versionOf(fileName: string): string | null {
  const m = /^instructions-([A-Za-z0-9._-]+)\.md$/.exec(fileName);
  return m ? m[1] : null;
}

function availableVersions(): string[] {
  return readdirSync(PROMPTS_DIR)
    .map(versionOf)
    .filter((v): v is string => v !== null)
    .sort();
}

/**
 * Which version is live, by content comparison — the active file carries no
 * marker of its own, and a stale marker would be worse than no marker.
 */
function activeVersion(versions: string[]): string | null {
  if (!existsSync(ACTIVE)) return null;
  const active = readFileSync(ACTIVE);
  for (const v of versions) {
    if (readFileSync(join(PROMPTS_DIR, `instructions-${v}.md`)).equals(active)) return v;
  }
  return null;
}

function main() {
  if (!existsSync(PROMPTS_DIR)) {
    console.error(`✖ ${PROMPTS_DIR}/ not found — run this from the project root.`);
    process.exit(1);
  }

  const versions = availableVersions();
  if (versions.length === 0) {
    console.error(`✖ No ${PROMPTS_DIR}/instructions-<version>.md files found.`);
    process.exit(1);
  }

  const current = activeVersion(versions);
  const requested = process.argv[2]?.trim();

  // No argument: report, don't guess.
  if (!requested) {
    console.log(`Available prompts : ${versions.join(", ")}`);
    console.log(
      current
        ? `Active            : ${current}`
        : `Active            : (unknown — ${ACTIVE} matches no version file; it was hand-edited)`,
    );
    console.log(`\nSwitch with:  npm run prompt:use ${versions[versions.length - 1]}`);
    return;
  }

  const version = requested.replace(/^instructions-|\.md$/g, "");
  const source = join(PROMPTS_DIR, `instructions-${version}.md`);
  if (!existsSync(source)) {
    console.error(`✖ Unknown prompt version "${requested}". Available: ${versions.join(", ")}`);
    process.exit(1);
  }

  if (current === version) {
    console.log(`✔ ${version} is already active — nothing to do.`);
    return;
  }

  // The outgoing bytes are always recoverable from their own version file, so
  // there is nothing to back up here; a hand-edited active file is the one case
  // that loses work, and it is called out loudly rather than silently clobbered.
  if (current === null && existsSync(ACTIVE)) {
    console.warn(
      `⚠ ${ACTIVE} matches no version file — it has local edits that this switch will discard.\n` +
        `  Save them as ${PROMPTS_DIR}/instructions-<name>.md first if you want to keep them.`,
    );
  }

  copyFileSync(source, ACTIVE);
  const size = readFileSync(ACTIVE, "utf8").length;
  console.log(`✔ Activated ${version} → ${ACTIVE} (${size.toLocaleString("en-US")} chars)`);
  console.log("  Restart the dev server — eve reads instructions.md at build time.");
}

main();
