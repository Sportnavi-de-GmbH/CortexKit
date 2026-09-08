// Drives one real turn against the local eve dev server so the LangSmith
// wiring can be verified end-to-end (guide §11, Step V3). Confirm the port
// from the eve dev log ("server listening at http://127.0.0.1:<port>") and
// pass it via EVE_HOST — a stale sibling dev server on the default port
// answers convincingly (guide §11, Step V2).
import "../lib/load-env.ts";

import { Client } from "eve/client";

const host = process.env.EVE_HOST ?? "http://127.0.0.1:3000";
const client = new Client({ host });

const prompt = process.argv.slice(2).join(" ").trim() || "What can you help me with?";

const session = client.session();
const response = await session.send(prompt);
console.log(`session=${response.sessionId}`);
const result = await response.result();
console.log(`status=${result.status}`);
// Full replies matter when judging eval spot-runs — override the log cap then.
// A failed turn has no message — report what the result DOES carry instead of
// crashing, so the session id above stays usable for trace inspection.
const cap = Number(process.env.LIVE_CHECK_MAX_CHARS) || 500;
if (result.message === undefined) {
  console.log(`message=(none) — full result: ${JSON.stringify(result).slice(0, cap)}`);
  process.exit(1);
}
console.log(`message=${JSON.stringify(result.message).slice(0, cap)}`);
