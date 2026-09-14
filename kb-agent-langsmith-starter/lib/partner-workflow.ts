// Server side of the V3 partner adapter: /api/partner/workflow → ${PARTNER_AGENT_HOST}/api/workflow
//
// The existing proxy (lib/partner-proxy.ts) only forwards eve/* paths, because the
// eve-based partner agents speak eve's session + SSE protocol. V3 is a plain
// JSON workflow (`POST /api/workflow` → WorkflowTrace), so it gets its own tiny
// forwarder. Same host normalisation, same self-target refusal, same shared
// secret as the proxy — the browser never talks to V3 directly.
//
// The widget POSTs `{ message, resume? }` (keeps `message` so the shared
// length gate `checkPartnerMessageLength` applies) and this maps it to V3's
// `{ query, resume }`.

import { isSelfTarget } from "./partner-proxy";

export interface WorkflowForwardDeps {
  /** Defaults to process.env.PARTNER_AGENT_HOST. */
  host?: string;
  /** Defaults to process.env.PARTNER_PROXY_SECRET. */
  secret?: string;
  fetchImpl?: typeof fetch;
  /** Upstream deadline; a V3 run is 10–45 s. */
  timeoutMs?: number;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export async function forwardToWorkflow(req: Request, deps: WorkflowForwardDeps = {}): Promise<Response> {
  const rawHost = (deps.host ?? process.env.PARTNER_AGENT_HOST ?? "").trim().replace(/\/+$/, "");
  const host = rawHost && !/^https?:\/\//i.test(rawHost) ? `https://${rawHost}` : rawHost;
  if (!host) return json({ detail: "Partner agent not configured." }, 503);

  const target = `${host}/api/workflow`;
  if (isSelfTarget(req.url, target, req.headers.get("host"))) {
    console.error(`[partner-workflow] PARTNER_AGENT_HOST (${host}) points at THIS service; refusing to forward.`);
    return json(
      { detail: "Partner agent misconfigured: PARTNER_AGENT_HOST points at this service itself. Set it to the partner agent's own host and port." },
      503,
    );
  }

  let body: { message?: unknown; resume?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ detail: "Body must be JSON." }, 400);
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return json({ detail: "message is required." }, 400);

  const headers = new Headers({ "content-type": "application/json" });
  const secret = deps.secret ?? process.env.PARTNER_PROXY_SECRET?.trim();
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
    return json({ detail: `Upstream unreachable: ${(e as Error).message}${causeText}` }, 502);
  }

  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { "Content-Type": upstream.headers.get("content-type") ?? "application/json" },
  });
}
