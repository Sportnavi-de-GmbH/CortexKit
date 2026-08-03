// Core logic for the /api/partner/* same-origin proxy — pure and testable
// (host + fetch injectable). The route handler in
// app/api/partner/[...path]/route.ts is a thin wrapper over this.
//
// WHY a proxy: the Partner Recommendation agent runs as a SEPARATE service/deploy.
// Proxying keeps the browser SAME-ORIGIN with the KB app, so the widget reuses the
// existing consent/BotID path and needs no CORS. Unset PARTNER_AGENT_HOST ⇒ 503, so
// the KB widget still works with no partner host configured.

// Hop-by-hop / host headers we must not forward (fetch recomputes length/encoding).
const STRIP = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
]);

export interface ProxyDeps {
  /** Defaults to process.env.PARTNER_AGENT_HOST. */
  host?: string;
  /** Defaults to global fetch (injectable for tests). */
  fetchImpl?: typeof fetch;
}

/** Only eve's own routes may be forwarded — this is NOT an open proxy. */
export function isForwardablePath(pathSegments: string[]): boolean {
  const path = pathSegments.join("/");
  return path === "eve" || path.startsWith("eve/");
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function proxyToPartner(
  req: Request,
  pathSegments: string[],
  deps: ProxyDeps = {},
): Promise<Response> {
  const host = (deps.host ?? process.env.PARTNER_AGENT_HOST ?? "").trim().replace(/\/+$/, "");
  const doFetch = deps.fetchImpl ?? fetch;

  if (!host) return json({ detail: "Partner agent not configured." }, 503);
  if (!isForwardablePath(pathSegments)) return json({ detail: "Not found." }, 404);

  const search = new URL(req.url).search;
  const target = `${host}/${pathSegments.join("/")}${search}`;

  const headers = new Headers();
  for (const [k, v] of req.headers) {
    if (!STRIP.has(k.toLowerCase())) headers.set(k, v);
  }

  const init: RequestInit = { method: req.method, headers, redirect: "manual" };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.arrayBuffer();
  }

  let upstream: Response;
  try {
    upstream = await doFetch(target, init);
  } catch (e) {
    return json({ detail: `Upstream unreachable: ${(e as Error).message}` }, 502);
  }

  // Stream the body straight back (SSE for the eve stream). Preserve status; copy
  // headers minus hop-by-hop ones.
  const respHeaders = new Headers();
  for (const [k, v] of upstream.headers) {
    if (!STRIP.has(k.toLowerCase())) respHeaders.set(k, v);
  }
  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}
