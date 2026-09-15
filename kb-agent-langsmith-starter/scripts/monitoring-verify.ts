// End-to-end check of the monitoring layer against a RUNNING widget.
//
//   npm run monitoring:verify                  # FAQ + partner turn, one vote each, read back from Supabase
//   npm run monitoring:verify -- --expect-failure   # point EVE_HOST at a widget with a broken Azure key first
//   npm run monitoring:verify -- --only delete       # skip the FAQ/partner turns; only the delete-cascade section
//
// Env: EVE_HOST (default http://127.0.0.1:3001), MONITORING_SUPABASE_URL/_SERVICE_ROLE_KEY,
// MONITORING_PASSWORD (from .env.local). Exit 1 on any failed check. Mirrors scripts/verify-langfuse.ts:
// the only honest check READS the rows back — a 2xx from the writer proves nothing.
import "../lib/load-env.ts";

import { randomUUID } from "node:crypto";
import { Client } from "eve/client";
import { supabaseAdmin } from "../lib/monitoring/store.ts";

const host = process.env.EVE_HOST ?? "http://127.0.0.1:3001";
const expectFailure = process.argv.includes("--expect-failure");
const onlyIdx = process.argv.indexOf("--only");
const only = onlyIdx !== -1 ? process.argv[onlyIdx + 1] : undefined;
const runTurns = only !== "delete";
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

// ------------------------------------------------------------------ delete
// Seeds a throwaway session + 2 traces (+ one step/error/feedback on the first),
// logs into the dashboard API, deletes trace 1 singly then trace 2 in bulk,
// asserts the cascade (steps/errors/feedback gone, session turn_count then gone
// entirely), then seeds and deletes one alert_events row. Cleans up anything of
// its own left behind, even on failure.
async function runDeleteSection(): Promise<void> {
  const sessionId = `verify-delete-${Date.now()}`;
  const trace1 = randomUUID();
  const trace2 = randomUUID();
  const step1 = randomUUID();
  const runSlot = `verify-delete:${Date.now()}`;
  let alertEventId: string | undefined;
  let cookie = "";

  try {
    // ---- seed
    const { error: sessErr } = await db!
      .from("agent_sessions")
      .upsert({ id: sessionId, agent: "faq", turn_count: 2 });
    check("delete: seed session", !sessErr, sessErr?.message ?? "");

    const now = new Date().toISOString();
    const { error: tracesErr } = await db!.from("traces").insert([
      {
        id: trace1, session_id: sessionId, agent: "faq", turn_id: "turn_0", turn_index: 0,
        status: "completed", started_at: now, ended_at: now, duration_ms: 500,
        user_input: "verify delete 1", final_output: "ok", metadata: { env: "development", verify: true },
      },
      {
        id: trace2, session_id: sessionId, agent: "faq", turn_id: "turn_1", turn_index: 1,
        status: "completed", started_at: now, ended_at: now, duration_ms: 500,
        user_input: "verify delete 2", final_output: "ok", metadata: { env: "development", verify: true },
      },
    ]);
    check("delete: seed 2 traces", !tracesErr, tracesErr?.message ?? "");

    const { error: stepErr } = await db!.from("trace_steps").insert({
      id: step1, trace_id: trace1, step_key: "verify-step", sequence: 0, kind: "response",
      name: "verify-step", title: "Verify step", status: "ok", input: { a: 1 }, output: { b: 2 },
    });
    check("delete: seed 1 step", !stepErr, stepErr?.message ?? "");

    const { error: errErr } = await db!.from("errors").insert({
      trace_id: trace1, step_id: step1, level: "warning", type: "unclassified", message: "verify",
    });
    check("delete: seed 1 error", !errErr, errErr?.message ?? "");

    const { error: fbErr } = await db!.from("feedback").insert({
      trace_id: trace1, session_id: sessionId, turn_id: "turn_0", agent: "faq", thumb: "up", epoch: 0,
    });
    check("delete: seed 1 feedback", !fbErr, fbErr?.message ?? "");

    // ---- log in to the dashboard API
    const password = process.env.MONITORING_PASSWORD ?? "";
    check("delete: MONITORING_PASSWORD set", password.length > 0);
    const loginRes = await fetch(`${host}/api/monitoring/auth`, {
      method: "POST", headers, body: JSON.stringify({ password }),
    });
    check("delete: login accepted", loginRes.ok, `HTTP ${loginRes.status}`);
    const setCookie = loginRes.headers.get("set-cookie") ?? "";
    cookie = setCookie.split(";")[0] ?? "";
    check("delete: session cookie received", cookie.length > 0);
    const authHeaders = { ...headers, cookie };

    // ---- delete trace 1 singly
    const del1Res = await fetch(`${host}/api/monitoring/traces/${trace1}`, { method: "DELETE", headers: authHeaders });
    const del1Body = (await del1Res.json().catch(() => ({}))) as Record<string, unknown>;
    check("delete: single trace 200", del1Res.ok, `HTTP ${del1Res.status}`);
    check("delete: single trace deleted:1", del1Body.deleted === 1, JSON.stringify(del1Body));
    check("delete: single trace feedback:1", del1Body.feedback === 1, JSON.stringify(del1Body));
    check(
      "delete: single trace reevaluate started|pending|skipped|failed",
      del1Body.reevaluate === "started" || del1Body.reevaluate === "pending" || del1Body.reevaluate === "skipped" || del1Body.reevaluate === "failed",
      String(del1Body.reevaluate),
    );

    await sleep(500);
    const { data: sessAfter1 } = await db!.from("agent_sessions").select("turn_count").eq("id", sessionId).maybeSingle();
    check("delete: session turn_count 1 after first delete", sessAfter1?.turn_count === 1, String(sessAfter1?.turn_count));
    const { data: stepsAfter1 } = await db!.from("trace_steps").select("id").eq("trace_id", trace1);
    check("delete: steps gone for trace 1", (stepsAfter1 ?? []).length === 0);
    const { data: errsAfter1 } = await db!.from("errors").select("id").eq("trace_id", trace1);
    check("delete: errors gone for trace 1", (errsAfter1 ?? []).length === 0);
    const { data: fbAfter1 } = await db!.from("feedback").select("id").eq("trace_id", trace1);
    check("delete: feedback gone for trace 1", (fbAfter1 ?? []).length === 0);

    // ---- delete trace 2 in bulk
    const del2Res = await fetch(`${host}/api/monitoring/traces`, {
      method: "DELETE", headers: authHeaders, body: JSON.stringify({ ids: [trace2] }),
    });
    const del2Body = (await del2Res.json().catch(() => ({}))) as Record<string, unknown>;
    check("delete: bulk trace 200", del2Res.ok, `HTTP ${del2Res.status}`);
    check("delete: bulk trace sessions_deleted:1", del2Body.sessions_deleted === 1, JSON.stringify(del2Body));

    await sleep(500);
    const { data: sessAfter2 } = await db!.from("agent_sessions").select("id").eq("id", sessionId).maybeSingle();
    check("delete: session gone after second delete", sessAfter2 === null || sessAfter2 === undefined);

    // ---- alert event: seed + delete
    const { error: aeErr } = await db!.from("alert_events").insert({
      kind: "test", rule_key: "failure_rate", agent: "faq", narrative: "verify", narrative_source: "template",
      run_slot: runSlot,
    });
    check("delete: seed alert event", !aeErr, aeErr?.message ?? "");
    const { data: aeRow } = await db!.from("alert_events").select("id").eq("run_slot", runSlot).maybeSingle();
    alertEventId = (aeRow as { id: string } | null)?.id;
    check("delete: alert event seeded and readable", Boolean(alertEventId));

    if (alertEventId) {
      const delAeRes = await fetch(`${host}/api/monitoring/alerts/events/${alertEventId}`, {
        method: "DELETE", headers: authHeaders,
      });
      const delAeBody = (await delAeRes.json().catch(() => ({}))) as Record<string, unknown>;
      check("delete: alert event 200", delAeRes.ok, `HTTP ${delAeRes.status}`);
      check("delete: alert event deleted:1", delAeBody.deleted === 1, JSON.stringify(delAeBody));
      const { data: aeAfter } = await db!.from("alert_events").select("id").eq("id", alertEventId).maybeSingle();
      check("delete: alert event gone", aeAfter === null || aeAfter === undefined);
    }
  } finally {
    // Never trust the checks above to have cleaned up — remove anything of ours that survived.
    await db!.from("feedback").delete().or(`trace_id.eq.${trace1},trace_id.eq.${trace2}`);
    await db!.from("errors").delete().or(`trace_id.eq.${trace1},trace_id.eq.${trace2}`);
    await db!.from("trace_steps").delete().or(`trace_id.eq.${trace1},trace_id.eq.${trace2}`);
    await db!.from("traces").delete().in("id", [trace1, trace2]);
    await db!.from("agent_sessions").delete().eq("id", sessionId);
    await db!.from("alert_events").delete().eq("run_slot", runSlot);
    if (cookie) {
      await fetch(`${host}/api/monitoring/auth`, { method: "DELETE", headers: { cookie } }).catch(() => undefined);
    }
  }
}

if (!runTurns) {
  await runDeleteSection();
  console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
  process.exit(failures ? 1 : 0);
}

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

// ------------------------------------------------------------------ delete
await runDeleteSection();

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
process.exit(failures ? 1 : 0);
