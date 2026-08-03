// Core logic for the /api/partner/* same-origin proxy — pure and testable
// (host + fetch injectable). The route handler in
// app/api/partner/[...path]/route.ts is a thin wrapper over this.
//
// WHY a proxy: the Partner Recommendation agent runs as a SEPARATE service/deploy.
// Proxying keeps the browser SAME-ORIGIN with the KB app, so the widget reuses the
// existing consent/BotID path and needs no CORS. Unset PARTNER_AGENT_HOST ⇒ 503, so
// the KB widget still works with no partner host configured.

// Headers we must not forward. Hop-by-hop / host headers, plus content-encoding
// and content-length: Node's fetch auto-DECOMPRESSES the upstream body, so relaying
// the stale `content-encoding: gzip` (with an already-decoded body) makes the browser
// fail to decode it ("Failed to fetch"). The length no longer matches either.
const STRIP = new Set([
  "host",
  "connection",
  "content-length",
  "content-encoding",
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

/**
 * SSE keep-alive. eve emits NOTHING while a tool runs — a partner search
 * (Supabase + embeddings, then a long generated answer) is routinely 30-60s of
 * silence. A browser drops an idle connection and surfaces it mid-turn as
 * "network error" (observed 2026-08-03: turn 1 rendered, the slower turn 2
 * errored), while curl happily waits. SSE comment lines (`: ...`) are ignored by
 * every SSE parser, so emitting one every 15s keeps the socket warm without
 * touching the event stream.
 */
export function withKeepAlive(
  body: ReadableStream<Uint8Array>,
  intervalMs = 15_000,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const reader = body.getReader();
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          stop(); // controller already closed
        }
      }, intervalMs);

      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) controller.enqueue(value);
          }
          controller.close();
        } catch (err) {
          try {
            controller.error(err);
          } catch {
            /* already errored */
          }
        } finally {
          stop();
        }
      })();
    },
    cancel(reason) {
      stop();
      return reader.cancel(reason);
    },
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

  // Event streams get keep-alive + explicit anti-buffering headers, so a long
  // silent turn survives the browser and any proxy in between.
  const isEventStream = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
  if (isEventStream && upstream.body) {
    respHeaders.set("Cache-Control", "no-cache, no-transform");
    respHeaders.set("X-Accel-Buffering", "no");
    return new Response(withKeepAlive(upstream.body), {
      status: upstream.status,
      headers: respHeaders,
    });
  }

  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}
