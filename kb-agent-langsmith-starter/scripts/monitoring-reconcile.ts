// Housekeeping for the monitoring tables. Idempotent; safe on a schedule.
//
//   npm run monitoring:reconcile
//
// 1. Traces still `running` after 5 minutes never completed (the serverless
//    invocation died) → status `failed`, metadata.abandoned = true, one
//    `trace.abandoned` event each.
// 2. Feedback rows written before their trace existed (trace_id null) → link
//    them by (session_id, turn_id) and refresh traces.feedback_thumb.
import "../lib/load-env.ts";

import { supabaseAdmin } from "../lib/monitoring/store.ts";

const db = supabaseAdmin();
if (!db) {
  console.error("MONITORING_SUPABASE_URL / MONITORING_SUPABASE_SERVICE_ROLE_KEY not set.");
  process.exit(2);
}

// --- 1. abandoned traces ---------------------------------------------------
const cutoff = new Date(Date.now() - 5 * 60_000).toISOString();
const { data: running, error: runErr } = await db.from("traces").select("id,session_id,turn_id,started_at").eq("status", "running").lt("started_at", cutoff);
if (runErr) {
  console.error("reading running traces failed:", runErr.message);
  process.exit(1);
}
let abandoned = 0;
for (const t of running ?? []) {
  const { error } = await db
    .from("traces")
    .update({ status: "failed", ended_at: new Date().toISOString(), metadata: { abandoned: true, abandoned_at: new Date().toISOString() } })
    .eq("id", t.id)
    .eq("status", "running");
  if (error) {
    console.error(`abandon ${t.id} failed:`, error.message);
    continue;
  }
  await db.from("events").insert({ type: "trace.abandoned", trace_id: t.id, session_id: t.session_id, payload: { turn_id: t.turn_id, started_at: t.started_at } });
  abandoned += 1;
}

// --- 2. unlinked feedback ----------------------------------------------------
const { data: unlinked, error: fbErr } = await db.from("feedback").select("id,session_id,turn_id").is("trace_id", null);
if (fbErr) {
  console.error("reading unlinked feedback failed:", fbErr.message);
  process.exit(1);
}
let linked = 0;
const touched = new Set<string>();
for (const f of unlinked ?? []) {
  const { data: trace } = await db.from("traces").select("id").eq("session_id", f.session_id).eq("turn_id", f.turn_id).maybeSingle();
  if (!trace) continue;
  const { error } = await db.from("feedback").update({ trace_id: trace.id }).eq("id", f.id);
  if (error) {
    console.error(`link feedback ${f.id} failed:`, error.message);
    continue;
  }
  touched.add(trace.id);
  linked += 1;
}
for (const traceId of touched) {
  const { data: latest } = await db.from("feedback").select("thumb").eq("trace_id", traceId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  await db.from("traces").update({ feedback_thumb: latest?.thumb ?? null }).eq("id", traceId);
}

console.log(`reconcile: abandoned=${abandoned} linked=${linked} (unlinked remaining=${(unlinked?.length ?? 0) - linked})`);
