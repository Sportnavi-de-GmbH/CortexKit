// End-to-end check of the monitoring layer against a RUNNING widget.
//
//   npm run monitoring:verify                  # FAQ + partner turn, one vote each, read back from Supabase
//   npm run monitoring:verify -- --expect-failure   # point EVE_HOST at a widget with a broken Azure key first
//
// Env: EVE_HOST (default http://127.0.0.1:3001), MONITORING_SUPABASE_URL/_SERVICE_ROLE_KEY (from .env.local).
// Exit 1 on any failed check. Mirrors scripts/verify-langfuse.ts: the only honest
// check READS the rows back — a 2xx from the writer proves nothing.
import "../lib/load-env.ts";

import { Client } from "eve/client";
import { supabaseAdmin } from "../lib/monitoring/store.ts";

const host = process.env.EVE_HOST ?? "http://127.0.0.1:3001";
const expectFailure = process.argv.includes("--expect-failure");
const db = supabaseAdmin();
if (!db) {
  console.error("MONITORING_SUPABASE_URL / MONITORING_SUPABASE_SERVICE_ROLE_KEY not set — nothing to verify against.");
  process.exit(2);
}

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label.padEnd(46)} ${detail}`);
  if (!ok) failures += 1;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const headers = { "content-type": "application/json", origin: host };

interface TraceRow {
  id: string; status: string; step_count: number; duration_ms: number | null; final_output: string | null;
  prompt_version_id: string | null; cost_estimate_usd: string | null; tokens_input: number | null; feedback_thumb: string | null;
}
interface StepRow { name: string; sequence: number; parent_step_id: string | null; input: unknown; output: unknown; model: string | null; tokens_input: number | null; tool_name: string | null }

async function traceFor(sessionId: string, turnId: string): Promise<TraceRow | null> {
  const { data } = await db!.from("traces").select("*").eq("session_id", sessionId).eq("turn_id", turnId).maybeSingle();
  return (data as TraceRow | null) ?? null;
}
async function stepsFor(traceId: string): Promise<StepRow[]> {
  const { data } = await db!.from("trace_steps").select("*").eq("trace_id", traceId).order("sequence");
  return (data ?? []) as StepRow[];
}
async function vote(sessionId: string, turnId: string, surface: "faq" | "partner"): Promise<void> {
  const res = await fetch(`${host}/api/feedback`, {
    method: "POST", headers,
    body: JSON.stringify({ sessionId, turnId, thumb: "up", epoch: 0, reason: null, comment: null, surface }),
  });
  check(`${surface}: vote accepted by /api/feedback`, res.ok, `HTTP ${res.status}`);
}

// ---------------------------------------------------------------- FAQ turn
const client = new Client({ host });
const session = client.session();
const response = await session.send(expectFailure ? "Was ist Firmenfitness?" : "Was ist Firmenfitness?");
const faqSession = response.sessionId;
const result = await response.result();
console.log(`faq session=${faqSession} status=${result.status}`);
// eve numbers turns from turn_0; the widget's feedback key is the same id.
const faqTurn = "turn_0";

if (expectFailure) {
  await sleep(3000);
  const t = await traceFor(faqSession, faqTurn);
  check("failure: trace exists", t !== null);
  check("failure: status failed", t?.status === "failed", t?.status);
  if (t) {
    const steps = await stepsFor(t.id);
    check("failure: failure step present", steps.some((s) => s.name === "failure"));
    const { data: errs } = await db!.from("errors").select("type,message").eq("trace_id", t.id);
    check("failure: errors row classified", Array.isArray(errs) && errs.length > 0 && typeof errs[0].type === "string" && errs[0].type !== "", JSON.stringify(errs?.[0] ?? null));
  }
  console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
  process.exit(failures ? 1 : 0);
}

// ------------------------------------------------------------- Partner turn
const partnerSession = `verify-${Date.now()}`;
const partnerTurn = "turn_1";
const pRes = await fetch(`${host}/api/partner/workflow`, {
  method: "POST", headers,
  body: JSON.stringify({ message: "Yoga in Bochum", sessionId: partnerSession, turnId: partnerTurn }),
  signal: AbortSignal.timeout(120_000),
});
console.log(`partner adapter HTTP ${pRes.status}`);
check("partner: adapter answered", pRes.ok, `HTTP ${pRes.status}`);

await vote(faqSession, faqTurn, "faq");
await vote(partnerSession, partnerTurn, "partner");
await sleep(3000);

// ------------------------------------------------------------------ FAQ read-back
const faq = await traceFor(faqSession, faqTurn);
check("faq: trace created automatically", faq !== null);
if (faq) {
  const steps = await stepsFor(faq.id);
  check("faq: status completed", faq.status === "completed", faq.status);
  check("faq: steps in order", steps.map((s) => s.name).join(",") === "request-received,load-knowledge-base,generate-answer,answer-delivered", steps.map((s) => s.name).join(" > "));
  check("faq: every step carries input or output", steps.every((s) => s.input != null || s.output != null));
  const gen = steps.find((s) => s.name === "generate-answer");
  check("faq: model call has model + tokens", Boolean(gen?.model) && (gen?.tokens_input ?? 0) > 0, `${gen?.model} / ${gen?.tokens_input}`);
  check("faq: cost > 0", Number(faq.cost_estimate_usd) > 0, String(faq.cost_estimate_usd));
  check("faq: duration > 0", (faq.duration_ms ?? 0) > 0, String(faq.duration_ms));
  check("faq: final output linked", Boolean(faq.final_output && faq.final_output.length > 0));
  check("faq: prompt version linked", faq.prompt_version_id !== null);
  check("faq: feedback linked to the trace", faq.feedback_thumb === "up", String(faq.feedback_thumb));
  const { data: fb } = await db!.from("feedback").select("trace_id").eq("session_id", faqSession).eq("turn_id", faqTurn);
  check("faq: feedback row references the trace id", Array.isArray(fb) && fb.some((r) => r.trace_id === faq.id));
  const { data: sess } = await db!.from("agent_sessions").select("turn_count").eq("id", faqSession).maybeSingle();
  check("faq: session row updated", (sess?.turn_count ?? 0) >= 1, String(sess?.turn_count));
}

// -------------------------------------------------------------- Partner read-back
const partner = await traceFor(partnerSession, partnerTurn);
check("partner: trace created automatically", partner !== null);
if (partner) {
  const steps = await stepsFor(partner.id);
  const top = steps.filter((s) => s.parent_step_id === null).map((s) => s.name);
  check("partner: status completed/needs_clarification", partner.status === "completed" || partner.status === "needs_clarification", partner.status);
  check("partner: top-level order", top.join(",") === "request-received,decompose,task,answer-composed", top.join(" > "));
  const search = steps.find((s) => s.name === "search");
  check("partner: tool step visible with response", search?.tool_name === "similarity_search" && search.output != null && typeof search.output === "object" && "perCity" in (search.output as object));
  check("partner: duration > 0", (partner.duration_ms ?? 0) > 0, String(partner.duration_ms));
  check("partner: cost > 0 (V3 usage surfaced)", Number(partner.cost_estimate_usd) > 0, String(partner.cost_estimate_usd));
  check("partner: final output linked", Boolean(partner.final_output && partner.final_output.length > 0));
  check("partner: feedback linked to the trace", partner.feedback_thumb === "up", String(partner.feedback_thumb));
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
process.exit(failures ? 1 : 0);
