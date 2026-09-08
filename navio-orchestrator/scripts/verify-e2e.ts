/**
 * verify-e2e.ts — routing + relay verification against a running dev server.
 *
 * Runs real turns and reports the numbers that decide whether the design
 * survives contact with reality:
 *
 *   R1  RELAY COST. The FAQ child's answer returns as a TOOL RESULT, so the
 *       master must re-emit it. Measured as total turn latency and
 *       time-to-first-visible-token (final turn of each case).
 *
 *   R2  STREAM SILENCE. Does eve's own /eve/v1/* stream keep producing events
 *       during a long tool call? Measured as the largest gap between events.
 *       ⚠ This is a Node client; CLAUDE.md §10.3 — long silent streams die in
 *       browsers, not in curl. Confirm streaming changes in a real browser too.
 *
 * ROUTING. Each case declares the capability it MUST reach, read off the wire.
 * Since 2026-09-08 (transcript-derived regression suite) cases can be
 * MULTI-TURN: `messages` are sent sequentially on ONE session and `expect`
 * applies to the FINAL turn — which is what exercises slot-filling ("Ich suche
 * ein Boxstudio" → "Berlin") and typo passthrough ("Bielefetd").
 *
 * GLOBAL INVARIANT (Harte Grenze 7): a turn whose visible text announces a
 * lookup ("schaue kurz nach" / "suche passende Partner") must carry a
 * capability call in that same turn. This is the speak-then-stall failure from
 * the 2026-09-08 live transcript, checked on EVERY turn of EVERY case.
 *
 *   npm run dev:ui -- -p 3020        # terminal 1
 *   npx tsx scripts/verify-e2e.ts    # terminal 2 (VERIFY_HOST overrides)
 */

import "../lib/load-env.ts";
import { Client } from "eve/client";

const HOST = process.env.VERIFY_HOST ?? "http://127.0.0.1:3020";

type Route = "faq" | "find_partners" | "request_human_contact";
const CAPABILITIES: readonly Route[] = ["faq", "find_partners", "request_human_contact"];

type Case = {
  name: string;
  /** Single-turn sugar — exactly one of message/messages. */
  message?: string;
  /** Multi-turn: sent sequentially on ONE session; `expect` applies to the FINAL turn. */
  messages?: string[];
  /** Capability the FINAL turn MUST reach. `null` = must answer without delegating. */
  expect: Route | null;
  /** Routes that must ALSO fire on the final turn (mixed intent, R6) … */
  expectAlso?: Route[];
  /** … unless the final reply matches this (the legitimate clarify path). */
  orFinalTextMatches?: RegExp;
  /** Routes that must fire on SOME turn of the case (any turn counts). */
  expectAcross?: Route[];
  /** 0-based turn indices that must call NO capability (asking a question is fine). */
  assertNoToolOn?: number[];
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
    name: "FAQ — English question",
    message: "tell me about sportnavi",
    expect: "faq",
  },
  {
    name: "PARTNER — place, not rule",
    message: "Wo kann ich in Bochum Yoga machen?",
    expect: "find_partners",
    skipIf: () => !process.env.PARTNER_AGENT_HOST,
  },
  {
    name: "MIXED — cancel contract + find box studio, then city",
    // Turn 1 must handle the FAQ half (faq call) even though the city is
    // missing; the search fires once "Berlin" arrives. `expectAcross` accepts
    // either ordering of the faq call across the two turns.
    messages: ["how can I cancel my contract and where can I find a box studio?", "Berlin"],
    expect: "find_partners",
    expectAcross: ["faq"],
    skipIf: () => !process.env.PARTNER_AGENT_HOST,
  },
  {
    name: "SLOT-FILL — pending sport + later city",
    messages: ["Ich suche ein Boxstudio", "Berlin"],
    expect: "find_partners",
    assertNoToolOn: [0],
    skipIf: () => !process.env.PARTNER_AGENT_HOST,
  },
  {
    name: "SLOT-FILL — typo city must pass through, never re-ask",
    messages: ["Ich suche ein Fitnessstudio", "Bielefetd"],
    expect: "find_partners",
    assertNoToolOn: [0],
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

/**
 * Capability calls in a turn's events, parsed from `actions.requested` /
 * `subagent.called` payloads. `ask_question` is reported separately — asking is
 * a legitimate non-delegating move, so `expect: null` must not fail on it.
 */
function callsFrom(events: Ev[]): { tools: Set<Route>; askedQuestion: boolean } {
  const tools = new Set<Route>();
  let askedQuestion = false;
  for (const e of events) {
    if (e.type !== "actions.requested" && e.type !== "subagent.called") continue;
    const d = (e.data ?? {}) as Record<string, unknown>;
    const names = new Set<string>();
    // Structured first (actions[].name / .toolName), the way the dev console
    // parses these events — substring-matching the blob false-positives once
    // user text (briefs, typo cities) rides through the payload.
    const actions = Array.isArray(d.actions) ? (d.actions as Record<string, unknown>[]) : [];
    for (const a of actions) {
      for (const key of ["name", "toolName"]) {
        if (typeof a[key] === "string") names.add(a[key] as string);
      }
    }
    for (const key of ["name", "toolName", "subagentName"]) {
      if (typeof d[key] === "string") names.add(d[key] as string);
    }
    for (const n of names) {
      if ((CAPABILITIES as readonly string[]).includes(n)) tools.add(n as Route);
      if (n === "ask_question") askedQuestion = true;
    }
  }
  return { tools, askedQuestion };
}

/** The speak-then-stall tell (Harte Grenze 7 / R2). */
const STALL = /schaue kurz nach|schaue nach|suche passende Partner/i;

type TurnSummary = {
  tools: Set<Route>;
  askedQuestion: boolean;
  parked: boolean;
  texts: string[];
  /** Texts of messages that ENDED in tool calls — the R2 announcement rides here. */
  narrations: string[];
  finalText: string;
  totalMs: number;
  firstTokenMs: number | null;
  maxGapMs: number;
};

async function runTurn(
  session: ReturnType<Client["session"]>,
  message: string,
): Promise<TurnSummary> {
  const started = Date.now();
  let firstToken: number | null = null;
  let lastEventAt = started;
  let maxGapMs = 0;
  let parked = false;
  const events: Ev[] = [];
  const texts: string[] = [];
  const narrations: string[] = [];
  let finalText = "";

  const response = await session.send({ message });
  for await (const event of response) {
    const now = Date.now();
    maxGapMs = Math.max(maxGapMs, now - lastEventAt);
    lastEventAt = now;

    const e = event as Ev;
    events.push(e);
    if (e.type === "message.appended" && firstToken === null) firstToken = now - started;
    if (e.type === "input.requested") parked = true;
    if (e.type === "message.completed") {
      const d = (e.data ?? {}) as Record<string, unknown>;
      const text = String(d.text ?? d.message ?? d.content ?? "");
      if (text) texts.push(text);
      if (d.finishReason === "tool-calls") {
        if (text) narrations.push(text);
      } else if (text) {
        finalText = text;
      }
    }
  }

  const { tools, askedQuestion } = callsFrom(events);
  return {
    tools,
    askedQuestion,
    parked,
    texts,
    narrations,
    finalText,
    totalMs: Date.now() - started,
    firstTokenMs: firstToken,
    maxGapMs,
  };
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
  console.log(`partner   ${process.env.PARTNER_AGENT_HOST ?? "(unset — partner cases skip)"}`);
  console.log("");

  let failures = 0;

  for (const c of CASES) {
    if (c.skipIf?.()) {
      console.log(`⏭  ${c.name} — skipped\n`);
      continue;
    }

    const msgs = c.messages ?? [c.message!];
    const session = client.session();
    const turns: TurnSummary[] = [];

    let streamError: string | null = null;
    for (const msg of msgs) {
      try {
        turns.push(await runTurn(session, msg));
      } catch (err) {
        streamError = String(err).slice(0, 200);
        break;
      }
    }
    if (streamError || turns.length === 0) {
      console.log(`❌ ${c.name}\n   stream error: ${streamError ?? "(no turns ran)"}\n`);
      failures++;
      continue;
    }

    const finalTurn = turns.at(-1)!;
    const problems: string[] = [];

    // (a) route assertion on the FINAL turn
    let routedOk =
      c.expect === null ? finalTurn.tools.size === 0 : finalTurn.tools.has(c.expect);
    if (!routedOk) problems.push(`final turn routed to [${[...finalTurn.tools].join(", ") || "nothing"}]`);

    // (b) AND-routes with the legitimate-clarify escape hatch
    if (routedOk && c.expectAlso?.length) {
      const allPresent = c.expectAlso.every((r) => finalTurn.tools.has(r));
      const clarified = c.orFinalTextMatches?.test(finalTurn.finalText) ?? false;
      if (!allPresent && !clarified) {
        routedOk = false;
        problems.push(`expected also [${c.expectAlso.join(", ")}] or a clarify question`);
      }
    }

    // (b2) routes that must fire on some turn of the case
    for (const r of c.expectAcross ?? []) {
      if (!turns.some((t) => t.tools.has(r))) {
        routedOk = false;
        problems.push(`expected ${r} to fire on some turn — it never did`);
      }
    }

    // (c) early turns that must not delegate
    for (const idx of c.assertNoToolOn ?? []) {
      const t = turns[idx];
      if (t && t.tools.size > 0) {
        routedOk = false;
        problems.push(`turn ${idx + 1} delegated to [${[...t.tools].join(", ")}] before it had the details`);
      }
    }

    // (d) GLOBAL speak-without-call invariant, every turn of every case
    for (const [i, t] of turns.entries()) {
      const announced = t.texts.some((x) => STALL.test(x));
      if (announced && t.tools.size === 0) {
        routedOk = false;
        problems.push(`HARTE-GRENZE-7: turn ${i + 1} announced a lookup but called nothing`);
      }
    }

    // (e) R2 announcement tracking — WARNING, not failure: measured 2026-09-08,
    // gpt-4o delegates silently on ~half of delegating turns regardless of
    // prompt wording, so the widget now renders the announcement ITSELF from
    // the wire events (NavioWidget's UI-side R2 fallback) and the visitor-facing
    // TTFT is covered. This warning keeps the model's own compliance visible so
    // a future router candidate can be judged on it.
    const warnings: string[] = [];
    for (const [i, t] of turns.entries()) {
      const delegated = t.tools.has("faq") || t.tools.has("find_partners");
      if (delegated && t.narrations.length === 0) {
        warnings.push(`R2: turn ${i + 1} delegated silently (UI fallback covers the visitor; model-side compliance miss)`);
      }
    }

    if (!routedOk) failures++;

    console.log(`${routedOk ? "✅" : "❌"} ${c.name}`);
    console.log(`   expected route   ${c.expect ?? "(none — answer directly)"}${c.expectAlso?.length ? " + " + c.expectAlso.join("+") : ""}`);
    console.log(
      `   actual (final)   ${finalTurn.tools.size ? [...finalTurn.tools].join(", ") : "(none)"}${finalTurn.askedQuestion ? " · asked a question" : ""}${finalTurn.parked ? " · parked on input.requested ✓" : ""}`,
    );
    if (turns.length > 1) {
      console.log(
        `   turns            ${turns.map((t, i) => `${i + 1}:[${[...t.tools].join(",") || (t.askedQuestion ? "ask" : "—")}]`).join(" ")}`,
      );
    }
    for (const p of problems) console.log(`   ✗ ${p}`);
    for (const w of warnings) console.log(`   ⚠ ${w}`);
    console.log(`   total            ${(finalTurn.totalMs / 1000).toFixed(1)}s   [R1]`);
    console.log(
      `   first token      ${finalTurn.firstTokenMs === null ? "never" : (finalTurn.firstTokenMs / 1000).toFixed(1) + "s"}   [R1 — the number the user feels]`,
    );
    console.log(
      `   max stream gap   ${(finalTurn.maxGapMs / 1000).toFixed(1)}s   [R2 ${finalTurn.maxGapMs > 25_000 ? "⚠ browsers may drop an idle connection here" : "ok"}]`,
    );
    console.log("");
  }

  console.log(failures === 0 ? "All routing expectations met." : `${failures} case(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
