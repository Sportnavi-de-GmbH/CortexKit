// Server side of the V3 partner adapter: /api/partner/workflow → ${PARTNER_WORKFLOW_HOST}/api/workflow
//
// The existing proxy (lib/partner-proxy.ts) only forwards eve/* paths, because the
// eve-based partner agents speak eve's session + SSE protocol. V3 is a plain
// JSON workflow (`POST /api/workflow` → WorkflowTrace), so it gets its own tiny
// forwarder. Same host normalisation and self-target refusal as the proxy.
//
// Security model (server-to-server):
//  - The browser only ever reaches THIS same-origin route; it never learns V3's
//    address or credential.
//  - V3 authenticates this forwarder with HTTP Basic `navio-proxy:<secret>`
//    (V3's lib/request-gate.ts). The pair PARTNER_WORKFLOW_HOST /
//    PARTNER_WORKFLOW_SECRET is dedicated to V3 and falls back to the eve-proxy
//    pair PARTNER_AGENT_HOST / PARTNER_PROXY_SECRET only when unset, so V3 can be
//    rolled out without rotating the secret shared with the other agents.
//  - V3's reply is a full WorkflowTrace (config, every stage's internals,
//    candidate scores, raw error messages) — fine between servers, not for a
//    browser. Only the UI projection below leaves this route, and every failure
//    is reported generically; the specifics go to the server log.
//
// The widget POSTs `{ message, resume? }` (keeps `message` so the shared
// length gate `checkPartnerMessageLength` applies) and this maps it to V3's
// `{ query, resume }`.

import { isSelfTarget } from "./partner-proxy";
import type { WorkflowTaskLite, WorkflowTraceLite } from "./workflow-agent-state";
import type { V3Recommendation } from "./v3-answer";

export interface WorkflowForwardDeps {
  /** Defaults to process.env.PARTNER_WORKFLOW_HOST, then PARTNER_AGENT_HOST. */
  workflowHost?: string;
  /** Defaults to process.env.PARTNER_WORKFLOW_SECRET, then PARTNER_PROXY_SECRET. */
  workflowSecret?: string;
  /** Test seam for the fallback pair. */
  host?: string;
  secret?: string;
  fetchImpl?: typeof fetch;
  /** Upstream deadline; a V3 run is 10–45 s. */
  timeoutMs?: number;
  /** Monitoring observer (lib/monitoring/partner-capture.ts). Awaited, but a
   *  throw or a slow write never changes the response. */
  observe?: (o: WorkflowObservation) => Promise<void> | void;
}

/** Everything the monitoring layer needs about one adapter round-trip. */
export interface WorkflowObservation {
  sessionId?: string;
  turnId?: string;
  message: string;
  origin: string | null;
  startedAt: string;
  /** Upstream HTTP status; 0 when the fetch itself failed. */
  status: number;
  /** The FULL WorkflowTrace when upstream returned parseable JSON. */
  trace?: unknown;
  /** Short diagnostic when there is no trace (fetch error, non-JSON body). */
  detail?: string;
}

const UNAVAILABLE = "Partner agent unavailable.";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function normalizeHost(raw: string | undefined): string {
  const h = (raw ?? "").trim().replace(/\/+$/, "");
  return h && !/^https?:\/\//i.test(h) ? `https://${h}` : h;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function taskLite(v: unknown): WorkflowTaskLite | null {
  if (!isRec(v) || typeof v.id !== "string" || typeof v.label !== "string" || typeof v.query !== "string") return null;
  return { id: v.id, label: v.label, query: v.query, cityMention: str(v.cityMention), priority: typeof v.priority === "number" ? v.priority : 1 };
}

function recommendation(v: unknown): V3Recommendation | null {
  if (!isRec(v) || typeof v.rank !== "number" || typeof v.id !== "number" || typeof v.name !== "string" || !isRec(v.card)) return null;
  const c = v.card;
  const strs = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);
  return {
    rank: v.rank, id: v.id, name: v.name, city: str(v.city) ?? "", role: v.role === "nearby" ? "nearby" : "target",
    distanceKm: typeof v.distanceKm === "number" ? v.distanceKm : 0,
    card: { logoUrl: str(c.logoUrl), street: str(c.street), postalCode: str(c.postalCode), email: str(c.email), phone: str(c.phone), websiteUrl: str(c.websiteUrl), mapsUrl: str(c.mapsUrl), tags: strs(c.tags), courses: strs(c.courses) },
  };
}

/**
 * What the browser gets: answer text, the multi-turn carry-over, and per-task
 * recommendations with their cards. Nothing else — see the header.
 */
export function projectTrace(trace: unknown): WorkflowTraceLite | null {
  if (!isRec(trace) || typeof trace.runId !== "string" || typeof trace.status !== "string") return null;
  const status = trace.status;
  if (status !== "ok" && status !== "needs_clarification" && status !== "partial" && status !== "failed") return null;
  const list = (x: unknown) => (Array.isArray(x) ? x.map(taskLite).filter((t): t is WorkflowTaskLite => t !== null) : []);
  const tasks = Array.isArray(trace.tasks)
    ? trace.tasks.flatMap((t) => {
        if (!isRec(t)) return [];
        const task = taskLite(t.task);
        const s = t.status;
        if (!task || (s !== "ok" && s !== "needs_clarification" && s !== "failed")) return [];
        const status: "ok" | "needs_clarification" | "failed" = s;
        const recs = Array.isArray(t.recommendations) ? t.recommendations.map(recommendation).filter((r): r is V3Recommendation => r !== null) : undefined;
        return [{ task, status, ...(recs ? { recommendations: recs } : {}) }];
      })
    : [];
  return {
    runId: trace.runId,
    status,
    ...(typeof trace.answer === "string" ? { answer: trace.answer } : {}),
    ...(typeof trace.clarification === "string" ? { clarification: trace.clarification } : {}),
    pending: list(trace.pending),
    deferred: list(trace.deferred),
    tasks,
  };
}

export async function forwardToWorkflow(req: Request, deps: WorkflowForwardDeps = {}): Promise<Response> {
  const host = normalizeHost(deps.workflowHost ?? process.env.PARTNER_WORKFLOW_HOST) || normalizeHost(deps.host ?? process.env.PARTNER_AGENT_HOST);
  if (!host) return json({ detail: "Partner agent not configured." }, 503);

  const target = `${host}/api/workflow`;
  if (isSelfTarget(req.url, target, req.headers.get("host"))) {
    console.error(`[partner-workflow] partner host (${host}) points at THIS service; refusing to forward.`);
    return json({ detail: "Partner agent misconfigured." }, 503);
  }

  let body: { message?: unknown; resume?: unknown; sessionId?: unknown; turnId?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ detail: "Body must be JSON." }, 400);
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return json({ detail: "message is required." }, 400);
  // Monitoring ids from the widget. Read here, NEVER forwarded — V3's request
  // schema stays untouched.
  const sessionId = typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim().slice(0, 200) : undefined;
  const turnId = typeof body.turnId === "string" && /^turn_\d+$/.test(body.turnId) ? body.turnId : undefined;
  const startedAt = new Date().toISOString();
  const observe = async (o: Pick<WorkflowObservation, "status" | "trace" | "detail">): Promise<void> => {
    if (!deps.observe) return;
    try {
      await deps.observe({ sessionId, turnId, message, origin: req.headers.get("origin"), startedAt, ...o });
    } catch (e) {
      console.error("[partner-workflow] observer failed:", { error: e instanceof Error ? e.name : "unknown" });
    }
  };

  const headers = new Headers({ "content-type": "application/json" });
  const secret = (deps.workflowSecret ?? process.env.PARTNER_WORKFLOW_SECRET ?? deps.secret ?? process.env.PARTNER_PROXY_SECRET)?.trim();
  if (secret) headers.set("authorization", `Basic ${Buffer.from(`navio-proxy:${secret}`).toString("base64")}`);

  const doFetch = deps.fetchImpl ?? fetch;
  let upstream: Response;
  try {
    upstream = await doFetch(target, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: message, ...(body.resume ? { resume: body.resume } : {}) }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 60_000),
    });
  } catch (e) {
    const cause = (e as Error & { cause?: Error & { code?: string } }).cause;
    const causeText = cause ? ` (${cause.code ?? ""} ${cause.message})`.trimEnd() : "";
    console.error(`[partner-workflow] fetch to ${target} failed: ${(e as Error).message}${causeText}`);
    await observe({ status: 0, detail: `fetch failed: ${(e as Error).message}${causeText}` });
    return json({ detail: UNAVAILABLE }, 502);
  }

  if (!upstream.ok) {
    console.error(`[partner-workflow] upstream ${upstream.status} from ${target}`);
    await observe({ status: upstream.status, detail: (await upstream.text().catch(() => "")).slice(0, 500) });
    return json({ detail: UNAVAILABLE }, 502);
  }
  let parsed: unknown;
  try {
    parsed = await upstream.json();
  } catch {
    console.error(`[partner-workflow] upstream returned non-JSON from ${target}`);
    await observe({ status: upstream.status, detail: "upstream returned non-JSON" });
    return json({ detail: UNAVAILABLE }, 502);
  }
  const lite = projectTrace(parsed);
  if (!lite) {
    console.error(`[partner-workflow] upstream JSON is not a WorkflowTrace`);
    await observe({ status: upstream.status, detail: "upstream JSON is not a WorkflowTrace" });
    return json({ detail: UNAVAILABLE }, 502);
  }
  if (lite.status === "failed" || lite.status === "partial") {
    const msg = isRec(parsed) && isRec(parsed.error) ? String(parsed.error.message) : "(no message)";
    console.error(`[partner-workflow] run ${lite.runId} ${lite.status}: ${msg}`);
  }
  await observe({ status: upstream.status, trace: parsed });
  return json(lite, 200);
}
