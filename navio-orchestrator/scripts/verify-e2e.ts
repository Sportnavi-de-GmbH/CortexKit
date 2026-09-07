/**
 * verify-e2e.ts — phase 1 exit criteria (architecture proposal §11).
 *
 * Runs real turns against a running dev server and reports the two numbers that
 * decide whether the design survives contact with reality:
 *
 *   R1  RELAY COST. The FAQ child's answer returns as a TOOL RESULT, so the
 *       master must re-emit it. Does that push a 2-8s answer to 8-15s?
 *       Measured as: total turn latency, and time-to-first-visible-token.
 *
 *   R2  STREAM SILENCE. Does eve's own /eve/v1/* stream keep producing events
 *       during a long tool call, or does it go silent long enough for a browser
 *       to drop the connection? Measured as: the largest gap between consecutive
 *       stream events.
 *       ⚠ This script is NOT the final word on R2 — it is a Node client, and
 *       CLAUDE.md §10.3 is explicit that long silent streams die in browsers,
 *       not in curl. Confirm in a real browser too.
 *
 * It also asserts routing: each case declares the capability it MUST reach, and
 * the script reads the actual tool calls off the wire.
 *
 *   npm run dev:ui -- -p 3020        # terminal 1
 *   npx tsx scripts/verify-e2e.ts    # terminal 2
 */

import "../lib/load-env.ts";
import { Client } from "eve/client";

const HOST = process.env.VERIFY_HOST ?? "http://127.0.0.1:3020";

type Case = {
  name: string;
  message: string;
  /** Tool/subagent the master MUST reach. `null` = must answer without delegating. */
  expect: "faq" | "find_partners" | "request_human_contact" | null;
  skipIf?: () => boolean;
};

const CASES: Case[] = [
  {
    name: "FAQ — knowledge question",
    message: "Was ist Firmenfitness bei Sportnavi?",
    expect: "faq",
  },
  {
    name: "FAQ — rule, not place (the classic confusion)",
    message: "Wie funktioniert der Check-in?",
    expect: "faq",
  },
  {
    name: "PARTNER — place, not rule",
    message: "Wo kann ich in Bochum Yoga machen?",
    expect: "find_partners",
    skipIf: () => !process.env.PARTNER_AGENT_HOST,
  },
  {
    name: "ESCALATION — account-specific, must ask for approval",
    message: "Auf meiner letzten Rechnung stimmt etwas nicht. Ich brauche jemanden vom Team.",
    expect: "request_human_contact",
  },
  {
    name: "OFF-TOPIC — must NOT delegate",
    message: "Wie wird das Wetter morgen in Berlin?",
    expect: null,
  },
];

type Ev = { type?: string; data?: unknown };

function toolNamesFrom(events: Ev[]): Set<string> {
  const names = new Set<string>();
  for (const e of events) {
    if (e.type !== "actions.requested" && e.type !== "subagent.called") continue;
    const blob = JSON.stringify(e.data ?? {});
    for (const n of ["faq", "find_partners", "request_human_contact", "ask_question"]) {
      // Match as a JSON string value to avoid substring false positives.
      if (blob.includes(`"${n}"`)) names.add(n);
    }
  }
  return names;
}

async function main() {
  const client = new Client({ host: HOST });

  try {
    const health = await client.health();
    console.log(`host      ${HOST}  (${health.status})`);
  } catch (err) {
    console.error(`Cannot reach ${HOST}. Start it with: npm run dev:ui -- -p 3020`);
    console.error(String(err));
    process.exit(1);
  }
  console.log(`router    ${process.env.AZURE_ROUTER_DEPLOYMENT_NAME ?? "(default)"}`);
  console.log(`faq       ${process.env.AZURE_AI_CHATBOT_DEPLOYMENT_NAME ?? "(default)"}`);
  console.log(`partner   ${process.env.PARTNER_AGENT_HOST ?? "(unset — partner case will skip)"}`);
  console.log("");

  let failures = 0;

  for (const c of CASES) {
    if (c.skipIf?.()) {
      console.log(`⏭  ${c.name} — skipped\n`);
      continue;
    }

    const session = client.session();
    const started = Date.now();
    let firstToken: number | null = null;
    let lastEventAt = started;
    let maxGapMs = 0;
    const events: Ev[] = [];

    let parked = false;
    try {
      const response = await session.send({ message: c.message });

      for await (const event of response) {
        const now = Date.now();
        maxGapMs = Math.max(maxGapMs, now - lastEventAt);
        lastEventAt = now;

        const e = event as Ev;
        events.push(e);
        if (e.type === "message.appended" && firstToken === null) firstToken = now - started;
        if (e.type === "input.requested") parked = true;
      }
    } catch (err) {
      console.log(`❌ ${c.name}\n   stream error: ${String(err).slice(0, 200)}\n`);
      failures++;
      continue;
    }

    const total = Date.now() - started;
    const tools = toolNamesFrom(events);
    const routedOk = c.expect === null ? tools.size === 0 : tools.has(c.expect);
    if (!routedOk) failures++;

    console.log(`${routedOk ? "✅" : "❌"} ${c.name}`);
    console.log(`   expected route   ${c.expect ?? "(none — answer directly)"}`);
    console.log(`   actual calls     ${tools.size ? [...tools].join(", ") : "(none)"}`);
    console.log(`   total            ${(total / 1000).toFixed(1)}s   [R1]`);
    console.log(
      `   first token      ${firstToken === null ? "never" : (firstToken / 1000).toFixed(1) + "s"}   [R1 — the number the user feels]`,
    );
    console.log(
      `   max stream gap   ${(maxGapMs / 1000).toFixed(1)}s   [R2 ${maxGapMs > 25_000 ? "⚠ browsers may drop an idle connection here" : "ok"}]`,
    );
    if (parked) console.log(`   parked on input.requested — the approval gate fired ✓`);
    console.log("");
  }

  console.log(failures === 0 ? "All routing expectations met." : `${failures} case(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
