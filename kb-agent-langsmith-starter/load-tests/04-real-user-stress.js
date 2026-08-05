// REAL-USER STRESS TEST — ⚠️ THIS ONE SPENDS AZURE/OPENAI TOKENS.
//
// Simulates concurrent visitors having genuine conversations with Navio:
//   1. POST /eve/v1/session      -> creates the session (202 + continuationToken)
//   2. GET  .../stream           -> reads the NDJSON answer to completion
// Both steps are timed separately so we can separate "queued" from "answered".
//
// COST CONTROL (read before running):
//   - The FAQ prompt is ~16.7k input tokens per turn; a partner search can exceed
//     40k (root CLAUDE.md §10.1). Iterations are therefore HARD-CAPPED, not
//     duration-driven, so the spend is bounded and predictable.
//   - Defaults: 45 FAQ turns + 6 partner searches ≈ a few euro at most.
//   - Tune with -e FAQ_ITERS=n -e PARTNER_ITERS=n.
//
// TPM SAFETY: Azure enforces a tokens-per-minute ceiling. If it is exceeded every
// request 429s (not just the excess), which would take the live widget down. The
// ramp is deliberately gentle and `tpm_429` is tracked as a first-class metric —
// if it climbs, we have found the ceiling and should stop.
import http from "k6/http";
import { check, group } from "k6";
import { Trend, Rate, Counter } from "k6/metrics";

const WIDGET = __ENV.WIDGET_URL || "https://navio-widget.vercel.app";
const FAQ_ITERS = Number(__ENV.FAQ_ITERS || 45);
const PARTNER_ITERS = Number(__ENV.PARTNER_ITERS || 6);

// Metrics
const createMs = new Trend("faq_session_create_ms");
const ttftMs = new Trend("faq_time_to_first_token_ms"); // server-side truth
const totalMs = new Trend("faq_answer_total_ms"); // server-side truth
const pCreateMs = new Trend("partner_session_create_ms");
const pTtftMs = new Trend("partner_time_to_first_token_ms");
const pTotalMs = new Trend("partner_answer_total_ms");
const okRate = new Rate("turn_success_rate");
const tpm429 = new Counter("tpm_429");
const streamErr = new Counter("stream_errors");
const emptyAnswer = new Counter("empty_answers");

// Realistic German visitor questions (FAQ agent).
const FAQ_QUESTIONS = [
  "Was ist Firmenfitness?",
  "Wie checke ich im Studio ein?",
  "Was kostet die Mitgliedschaft?",
  "Wie werde ich Partner bei Sportnavi?",
  "Kann ich meinen Vertrag pausieren?",
  "Wie funktioniert das Cashback?",
  "Welche Tarife gibt es?",
  "Kann ich die Mitgliedschaft kündigen?",
  "Was ist Sportnavi für Firmen?",
  "Brauche ich einen Vertrag?",
];

// Partner searches — expensive, kept few.
const PARTNER_QUERIES = [
  "Yoga in Bochum",
  "Fitnessstudio in Bielefeld",
  "Klettern für Anfänger in Dortmund",
  "Schwimmen in Essen",
  "Reha-Sport in Bochum",
  "Pilates in Bielefeld",
];

export const options = {
  scenarios: {
    // Gentle concurrency ramp so we can see degradation before it becomes failure.
    faq_users: {
      executor: "shared-iterations",
      vus: Math.min(5, FAQ_ITERS), // 5 simultaneous visitors (VUs can't exceed iterations)
      iterations: FAQ_ITERS,
      maxDuration: "10m",
      exec: "faqUser",
    },
    // Partner searches start later so the two don't compound the TPM spike.
    partner_users: {
      executor: "shared-iterations",
      vus: Math.min(2, PARTNER_ITERS),
      iterations: PARTNER_ITERS,
      maxDuration: "10m",
      startTime: "45s",
      exec: "partnerUser",
    },
  },
  thresholds: {
    turn_success_rate: ["rate>0.95"],
    faq_time_to_first_token_ms: ["p(95)<8000"], // user-perceived responsiveness
    faq_answer_total_ms: ["p(95)<30000"],
    tpm_429: ["count<5"], // more than a handful means we hit the Azure ceiling
  },
};

/** Drive one full turn: create the session, then read the stream to completion. */
function runTurn(path, message, tags) {
  const t0 = Date.now();
  const create = http.post(`${WIDGET}${path}`, JSON.stringify({ message }), {
    headers: { "content-type": "application/json" },
    tags,
    timeout: "60s",
  });
  const createElapsed = Date.now() - t0;

  if (create.status === 429) tpm429.add(1);
  if (create.status !== 202 && create.status !== 200) {
    okRate.add(false);
    return { ok: false, createElapsed, answerElapsed: 0, status: create.status };
  }

  let body;
  try {
    body = create.json();
  } catch (e) {
    okRate.add(false);
    return { ok: false, createElapsed, answerElapsed: 0, status: create.status };
  }
  const sid = body.sessionId;
  const tok = body.continuationToken;
  if (!sid || !tok) {
    okRate.add(false);
    return { ok: false, createElapsed, answerElapsed: 0, status: create.status };
  }

  // Read the answer stream to completion. k6 buffers the whole body, so this
  // measures the full time-to-complete-answer as a real user experiences it.
  const t1 = Date.now();
  const stream = http.get(
    `${WIDGET}${path}/${sid}/stream?continuationToken=${encodeURIComponent(tok)}`,
    { tags, timeout: "180s" },
  );
  const answerElapsed = Date.now() - t1;

  if (stream.status === 429) tpm429.add(1);
  if (stream.status !== 200) {
    streamErr.add(1);
    okRate.add(false);
    return { ok: false, createElapsed, answerElapsed, status: stream.status };
  }

  // A healthy turn emits message.appended deltas. No deltas = empty bubble,
  // which is the failure mode documented in CLAUDE.md §10.2.
  const raw = stream.body || "";
  const gotText = raw.includes("message.appended");
  if (!gotText) emptyAnswer.add(1);
  okRate.add(gotText);

  // IMPORTANT: `answerElapsed` above is NOT the answer latency — eve holds the
  // SSE connection open (~120s) after the answer is finished, and k6 buffers the
  // whole body, so it measures connection lifetime. The real, server-side
  // latency is recovered from the NDJSON event timestamps.
  const srv = parseServerTimings(raw);

  return { ok: gotText, createElapsed, answerElapsed, status: 200, srv };
}

/**
 * Recover true latency from the event stream's own timestamps:
 *   ttft  = session.started -> first message.appended  (what the user "feels")
 *   total = session.started -> turn.completed          (full answer)
 */
function parseServerTimings(raw) {
  let t0 = null, tFirst = null, tEnd = null;
  const lines = raw.split("\n");
  for (const line of lines) {
    if (!line || line[0] !== "{") continue;
    let ev;
    try { ev = JSON.parse(line); } catch (e) { continue; }
    const at = ev && ev.meta && ev.meta.at ? Date.parse(ev.meta.at) : null;
    if (!at) continue;
    if (t0 === null) t0 = at; // first event is session.started / turn.started
    if (tFirst === null && ev.type === "message.appended") tFirst = at;
    if (ev.type === "turn.completed" || ev.type === "turn.failed") tEnd = at;
  }
  return {
    ttft: t0 !== null && tFirst !== null ? tFirst - t0 : null,
    total: t0 !== null && tEnd !== null ? tEnd - t0 : null,
  };
}

export function faqUser() {
  const q = FAQ_QUESTIONS[Math.floor(Math.random() * FAQ_QUESTIONS.length)];
  group("FAQ turn", () => {
    const r = runTurn("/eve/v1/session", q, { agent: "faq" });
    createMs.add(r.createElapsed);
    if (r.ok && r.srv) {
      if (r.srv.ttft !== null) ttftMs.add(r.srv.ttft);
      if (r.srv.total !== null) totalMs.add(r.srv.total);
    }
    check(r, {
      "FAQ turn produced an answer": (x) => x.ok === true,
      "FAQ no server error": (x) => x.status < 500,
      "FAQ not rate-limited by Azure": (x) => x.status !== 429,
    });
  });
}

export function partnerUser() {
  const q = PARTNER_QUERIES[Math.floor(Math.random() * PARTNER_QUERIES.length)];
  group("Partner search", () => {
    const r = runTurn("/api/partner/eve/v1/session", q, { agent: "partner" });
    pCreateMs.add(r.createElapsed);
    if (r.ok && r.srv) {
      if (r.srv.ttft !== null) pTtftMs.add(r.srv.ttft);
      if (r.srv.total !== null) pTotalMs.add(r.srv.total);
    }
    check(r, {
      "Partner search produced an answer": (x) => x.ok === true,
      "Partner no server error": (x) => x.status < 500,
    });
  });
}
