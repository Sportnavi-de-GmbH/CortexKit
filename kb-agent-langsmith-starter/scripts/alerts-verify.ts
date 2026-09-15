// scripts/alerts-verify.ts — proves the whole loop against a RUNNING widget + the real Supabase:
// seed a breach → evaluate → event + Teams sent → clear → evaluate → recovered → evaluate → no-op.
//
//   npm run alerts:verify                 # EVE_HOST default http://127.0.0.1:3001
// Env: ALERT_EVALUATE_SECRET, MONITORING_SUPABASE_URL/_SERVICE_ROLE_KEY (from .env.local).
import "../lib/load-env.ts";
import { supabaseAdmin } from "../lib/monitoring/store.ts";

const host = process.env.EVE_HOST ?? "http://127.0.0.1:3001";
const secret = process.env.ALERT_EVALUATE_SECRET ?? "";
const db = supabaseAdmin();
if (!db || !secret) { console.error("Need MONITORING_SUPABASE_* and ALERT_EVALUATE_SECRET."); process.exit(2); }

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${label.padEnd(50)} ${detail}`); if (!ok) failures += 1; };
const SESSION = `alerts-verify-${Date.now()}`;

async function evaluate(slot: "test" | "manual" = "manual") {
  const res = await fetch(`${host}/api/monitoring/alerts/evaluate`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${secret}` }, body: JSON.stringify({ slot }) });
  return { status: res.status, body: (await res.json()) as { transitions: { kind: string; rule_key: string; agent: string; delivery?: { teams: string } }[]; digest: { sent: boolean } } };
}
async function seed(n: number, status: "failed" | "completed") {
  await db!.from("agent_sessions").upsert({ id: SESSION, agent: "faq" });
  const rows = Array.from({ length: n }, (_, i) => ({
    session_id: SESSION, agent: "faq", turn_id: `turn_${i}`, turn_index: i, status, started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(), duration_ms: 1000, user_input: "verify", metadata: { env: "production", verify: true },
  }));
  const { error } = await db!.from("traces").upsert(rows, { onConflict: "session_id,turn_id" });
  if (error) throw new Error(error.message);
}
async function cleanup() {
  await db!.from("traces").delete().eq("session_id", SESSION);
  await db!.from("agent_sessions").delete().eq("id", SESSION);
  const { data } = await db!.from("alert_rules").select("id").eq("key", "failure_rate").eq("agent", "all").maybeSingle();
  if (data) await db!.from("alert_state").delete().eq("rule_id", (data as { id: string }).id);
}

(async () => {
  try {
    // Unauthorized
    const unauth = await fetch(`${host}/api/monitoring/alerts/evaluate`, { method: "POST" });
    check("evaluate without bearer → 401", unauth.status === 401, String(unauth.status));

    // Baseline run so the state exists as ok (or breached from real traffic — we only assert on OUR transition).
    await evaluate("manual");

    // 1. seed a breach: 30 failed production traces → failure_rate total & faq breached
    await seed(30, "failed");
    const r1 = await evaluate("manual");
    const fired = r1.body.transitions.find((t) => t.kind === "fired" && t.rule_key === "failure_rate" && t.agent === "faq");
    check("breach fires failure_rate · faq", Boolean(fired), JSON.stringify(r1.body.transitions.map((t) => `${t.kind}:${t.rule_key}:${t.agent}`)));
    check("teams delivery attempted", fired?.delivery?.teams === "sent" || fired?.delivery?.teams === "skipped", fired?.delivery?.teams ?? "—");
    const { data: ev } = await db!.from("alert_events").select("id,kind,narrative_source").eq("kind", "fired").eq("rule_key", "failure_rate").eq("agent", "faq").order("created_at", { ascending: false }).limit(1);
    check("fired event row written", (ev?.length ?? 0) === 1, ev?.[0] ? `narrative=${(ev[0] as { narrative_source: string }).narrative_source}` : "");

    // 2. clear: mark them completed → recovered
    await seed(30, "completed");
    const r2 = await evaluate("manual");
    check("recovery transition", r2.body.transitions.some((t) => t.kind === "recovered" && t.rule_key === "failure_rate" && t.agent === "faq"));

    // 3. no-op
    const r3 = await evaluate("manual");
    check("third run: no transition", !r3.body.transitions.some((t) => t.rule_key === "failure_rate" && t.agent === "faq"));
    check("test/manual slot never sends the digest", r3.body.digest.sent === false);
  } catch (e) {
    check("script error", false, (e as Error).message);
  } finally {
    await cleanup();
  }
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
