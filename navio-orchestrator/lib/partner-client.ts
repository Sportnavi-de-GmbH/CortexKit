/**
 * partner-client.ts — talks to the Partner Agent deployment (service 2).
 *
 * ⚠ THIS FILE IS THE SWAP POINT.
 * The architecture proposal (§4.2) chose the HTTP approach over eve's
 * `defineRemoteAgent`. Everything that decision costs us is contained here, so
 * migrating later is one file plus an `agent/subagents/partner.ts`:
 *
 *   import { defineRemoteAgent } from "eve";
 *   import { vercelOidc } from "eve/agents/auth";
 *   export default defineRemoteAgent({
 *     url: () => process.env.PARTNER_AGENT_HOST!,
 *     description: "<same text as find_partners' description>",
 *     auth: vercelOidc(),          // ← also closes the shared-secret gap (§11.2)
 *   });
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS USES RAW fetch AND NOT `eve/client`
 *
 * The first version used `eve/client`'s typed `Client`/`ClientSession`, which is
 * the right tool for scripts. Called from a SCRIPT it worked fine: ~10-15s for a
 * Bochum search. Called from inside a tool's `execute`, the same code hung
 * indefinitely — one measured turn ran 321s, another never settled at all, and
 * critically the 90s `setTimeout` guard NEVER FIRED.
 *
 * A timeout that does not fire is the tell. Tool execution runs inside eve's
 * durable workflow engine, which owns suspension and replay; wall-clock JS
 * timers are not a reliable escape hatch there. So this module now:
 *
 *   1. uses plain `fetch`, whose deadline is `AbortSignal.timeout()` — enforced
 *      by the network layer, not by a JS timer the runtime can suspend, and
 *   2. reads the NDJSON stream itself, so nothing between us and the socket can
 *      park waiting on a promise that never settles.
 *
 * Keep it that way. If you reintroduce `eve/client` here, re-measure a real
 * partner turn END TO END THROUGH THE AGENT (not via a script) before believing
 * it works — that difference is exactly what hid this bug.
 *
 * There is also NO /api/partner proxy in this project. The old proxy existed
 * because the BROWSER called the partner agent; the call is server-side now, so
 * there is no CORS, no SSRF surface, and no SSE keep-alive to inject.
 */

/** Hard ceiling for one partner search. A dense city takes 30–60s. */
const TIMEOUT_MS = Number(process.env.PARTNER_AGENT_TIMEOUT_MS ?? 90_000);

export type PartnerSearchResult =
  | {
      ok: true;
      /** The partner agent's German prose answer, verbatim. */
      answer: string;
      /** Work-actually-performed metric — see CortexKit CLAUDE.md §10.4. False
       *  means the partner agent answered WITHOUT querying its database, the
       *  signature of a hallucinating "cost optimization". Never ignore it. */
      searchPerformed: boolean;
      /**
       * Service 2's OWN eve session id.
       *
       * The cross-project trace link. The partner service traces its search in
       * full — city resolution, gap-fill, ranking — into its own Langfuse
       * project ("Navio — Partner"), which this process cannot write to (one
       * process exports to one project). Carrying its session id back lets the
       * orchestration trace point at that detail instead of pretending to
       * contain it. Recorded as `partner.session_id` on the trace.
       */
      sessionId: string;
    }
  | { ok: false; error: string };

function resolveHost(): string | null {
  const raw = process.env.PARTNER_AGENT_HOST?.trim();
  if (!raw) return null;
  // Mirrors the fix in service 1's proxy: a bare host (no scheme) is assumed
  // https, otherwise `new URL()` throws and the tool fails for a config typo.
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withScheme.replace(/\/+$/, "");
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  // Service 2 is NOT openly reachable in production (§11.2): its /eve/v1
  // channel admits exactly one credential — HTTP Basic with the fixed username
  // "navio-proxy" and PARTNER_PROXY_SECRET as the password, the same form
  // service 1's proxy sends (kb-agent-langsmith-starter/lib/partner-proxy.ts).
  // Its /api/feedback checks the bare header instead, so both are sent.
  // Locally the secret is blank and service 2's localDev() admits loopback.
  const secret = process.env.PARTNER_PROXY_SECRET?.trim();
  if (secret) {
    h["x-navio-proxy-secret"] = secret;
    h.authorization = `Basic ${Buffer.from(`navio-proxy:${secret}`).toString("base64")}`;
  }
  return h;
}

/** Events we care about, kept loose — we only read a few fields. */
type StreamEvent = { type?: string; data?: Record<string, unknown> };

/**
 * Runs one partner search. Never throws — the master model has to recover
 * inside the same turn, so every failure returns `{ ok: false }` with a message
 * it can explain honestly instead of inventing studios.
 */
export async function searchPartners(query: string): Promise<PartnerSearchResult> {
  const host = resolveHost();
  if (!host) {
    return {
      ok: false,
      error:
        "PARTNER_AGENT_HOST is not configured, so partner search is unavailable in this deployment.",
    };
  }

  // ONE deadline covers session creation AND the whole stream read. Because it
  // is an AbortSignal rather than a timer callback, the fetch itself is torn
  // down when it expires, even if the surrounding runtime suspends timers.
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const timedOut = () =>
    ({
      ok: false as const,
      error: `Partner search exceeded ${Math.round(TIMEOUT_MS / 1000)}s and was cancelled.`,
    });

  let sessionId: string | undefined;

  try {
    // 1 — create the session and dispatch the turn.
    const created = await fetch(`${host}/eve/v1/session`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ message: query }),
      signal,
      redirect: "manual",
    });

    if (!created.ok) {
      return { ok: false, error: `Partner service returned HTTP ${created.status}.` };
    }

    const body = (await created.json()) as { sessionId?: string };
    sessionId =
      body.sessionId ?? created.headers.get("x-eve-session-id") ?? undefined;
    if (!sessionId) {
      return { ok: false, error: "Partner service did not return a session id." };
    }

    // 2 — read the NDJSON event stream to the turn boundary.
    const stream = await fetch(
      `${host}/eve/v1/session/${encodeURIComponent(sessionId)}/stream`,
      { headers: headers(), signal, redirect: "manual" },
    );
    if (!stream.ok || !stream.body) {
      return { ok: false, error: `Partner stream returned HTTP ${stream.status}.` };
    }

    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let answer = "";
    let searchPerformed = false;
    let failure: string | null = null;
    let settled = false;

    const handle = (event: StreamEvent) => {
      const d = (event.data ?? {}) as Record<string, any>;
      switch (event.type) {
        case "message.completed":
          // Interim narration before a tool call also arrives as
          // message.completed; only a non-tool-calls finish is the real answer.
          if (d.finishReason !== "tool-calls" && typeof d.message === "string") {
            answer = d.message;
          }
          break;
        case "actions.requested":
          // Did service 2 actually hit its database?
          if (JSON.stringify(d).includes("find_partners")) searchPerformed = true;
          break;
        case "turn.failed":
        case "session.failed":
          failure = String(d.message ?? d.code ?? "unknown error");
          settled = true;
          break;
        case "turn.cancelled":
        case "session.waiting":
        case "session.completed":
          settled = true;
          break;
      }
    };

    try {
      while (!settled) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffered.indexOf("\n")) !== -1) {
          const line = buffered.slice(0, nl).trim();
          buffered = buffered.slice(nl + 1);
          if (!line) continue;
          try {
            handle(JSON.parse(line) as StreamEvent);
          } catch {
            // A partial or non-JSON line is not fatal; keep reading.
          }
          if (settled) break;
        }
      }
    } finally {
      void reader.cancel().catch(() => {});
    }

    if (failure) return { ok: false, error: `The partner service reported: ${failure}` };

    answer = answer.trim();
    if (!answer) {
      // Bug §10.2's signature: a turn ending with zero assistant text. Service 2
      // disables `ask_question` to prevent it; if that ever regresses we must
      // not render an empty bubble.
      return { ok: false, error: "The partner service returned an empty answer." };
    }

    return { ok: true, answer, searchPerformed, sessionId };
  } catch (err) {
    if (signal.aborted) {
      // Courtesy: stop service 2 burning Azure tokens on an answer nobody reads.
      if (sessionId) {
        void fetch(`${host}/eve/v1/session/${encodeURIComponent(sessionId)}/cancel`, {
          method: "POST",
          headers: headers(),
        }).catch(() => {});
      }
      return timedOut();
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Partner service unreachable: ${message}` };
  }
}
