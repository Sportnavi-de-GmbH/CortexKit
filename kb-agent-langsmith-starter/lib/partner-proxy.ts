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
  // undici refuses to send `Expect` (UND_ERR_NOT_SUPPORTED), so forwarding a
  // client's `Expect: 100-continue` makes every proxied request 502.
  "expect",
]);

export interface ProxyDeps {
  /** Defaults to process.env.PARTNER_AGENT_HOST. */
  host?: string;
  /** Defaults to global fetch (injectable for tests). */
  fetchImpl?: typeof fetch;
}

/** Spellings that all mean "this machine". A string compare of the configured
 *  host against our own is not enough: the browser addresses the widget as
 *  `localhost` while `PARTNER_AGENT_HOST` is written `127.0.0.1` (or the other
 *  way round), which is exactly how the 2026-08-18 misroute went unnoticed. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

/** `host:port`, with loopback spellings folded together and the default port
 *  made explicit so `https://x` and `https://x:443` compare equal. */
function originKey(url: URL): string {
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const name = LOOPBACK.has(hostname) ? "localhost" : hostname;
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return `${name}:${port}`;
}

/**
 * True when the configured partner host resolves to THIS service.
 *
 * Forwarding `/api/partner/eve/*` to our own origin sends the request straight
 * back into the FAQ agent's `/eve/*`, so the widget's "Partner finden" screen
 * is answered by the FAQ agent — with no error anywhere. Observed live on
 * 2026-08-18: "Fitnessstudio in Bielefeld" was answered with "go back and
 * choose Partner finden", and the turn was traced into the FAQ Langfuse
 * project instead of the Partner one.
 *
 * This is never a valid configuration, so it is detected rather than served.
 */
export function isSelfTarget(requestUrl: string, target: string, hostHeader?: string | null): boolean {
  let targetKey: string;
  try {
    targetKey = originKey(new URL(target));
  } catch {
    return false; // an unparseable target fails later, with its own error
  }

  const candidates: string[] = [];
  let protocol = "http:";
  try {
    const self = new URL(requestUrl);
    protocol = self.protocol;
    candidates.push(originKey(self));
  } catch {
    // request URL not absolute — fall back to the Host header alone
  }
  // Behind a proxy the Host header is the address the CLIENT used, which is the
  // one a misconfigured env var is most likely to have been copied from.
  if (hostHeader) {
    try {
      candidates.push(originKey(new URL(`${protocol}//${hostHeader}`)));
    } catch {
      // ignore a malformed Host header
    }
  }

  return candidates.includes(targetKey);
}

/** Only eve's own routes may be forwarded — this is NOT an open proxy. */
export function isForwardablePath(pathSegments: string[]): boolean {
  // Reject path-traversal segments before the prefix check: without this,
  // ["eve","..","admin"] joins to "eve/../admin", passes the `eve/` prefix, and
  // could escape the eve namespace on the upstream. Encoded forms never reach
  // here — Next.js decodes the catch-all segments before this runs.
  if (pathSegments.some((s) => s === ".." || s === ".")) return false;
  const path = pathSegments.join("/");
  return path === "eve" || path.startsWith("eve/");
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// --- Request gate for /api/partner/* -----------------------------------------
// This route is a plain Next.js handler and sits OUTSIDE eve's channel auth (eve
// owns only /eve/v1/*), so the origin + size checks that agent/channels/eve.ts
// applies to the FAQ agent do not run here. Mirror them so a partner turn gets
// the same front-door protection as a FAQ turn (defense in depth behind the
// Vercel Firewall rules on /api/partner/).

/** Same body-size cap as the eve channel (shared `NAVIO_MAX_REQUEST_BYTES`). */
const MAX_REQUEST_BYTES = Number(process.env.NAVIO_MAX_REQUEST_BYTES ?? 16_000);

function requestHost(req: Request): string | null {
  return req.headers.get("x-forwarded-host") ?? req.headers.get("host");
}

/** The origin the caller claims, from `Origin` or (fallback) `Referer`. */
function callerOrigin(req: Request): string | null {
  const origin = req.headers.get("origin");
  if (origin) return origin;
  const referer = req.headers.get("referer");
  if (referer) {
    try {
      return new URL(referer).origin;
    } catch {
      return null;
    }
  }
  return null;
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
  } catch {
    return false;
  }
}

function extraAllowedOrigins(): string[] {
  return (process.env.WIDGET_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

/**
 * Reject an oversized body (413) or a foreign browser origin (403) BEFORE
 * forwarding upstream. Returns a Response to reject, or `null` to continue.
 * A missing Origin (same-origin GET streams, non-browser callers) is deferred
 * to the edge and the partner service's own auth — same policy as the eve
 * channel, so the streaming route keeps working.
 */
export function checkPartnerRequest(req: Request): Response | null {
  if (MAX_REQUEST_BYTES > 0) {
    const len = req.headers.get("content-length");
    if (len) {
      const bytes = Number(len);
      if (Number.isFinite(bytes) && bytes > MAX_REQUEST_BYTES) {
        return json({ detail: "Message too large." }, 413);
      }
    }
  }

  const origin = callerOrigin(req);
  if (origin) {
    const allowed = new Set<string>(extraAllowedOrigins());
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      /* malformed Origin — fall through to reject */
    }
    const sameOrigin = !!originHost && originHost === requestHost(req);
    if (!allowed.has(origin) && !sameOrigin && !isLoopbackOrigin(origin)) {
      return json({ detail: "Origin not allowed." }, 403);
    }
  }

  return null;
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
  // Normalize the configured host. A value pasted without a scheme
  // ("navio-partner.vercel.app") would make `${host}/...` a relative string, and
  // Node's fetch rejects it with "Failed to parse URL" → an opaque 502 on every
  // partner turn. Default to https:// so the common dashboard typo just works;
  // an explicit http:// (local dev, e.g. http://127.0.0.1:3001) is preserved.
  const rawHost = (deps.host ?? process.env.PARTNER_AGENT_HOST ?? "").trim().replace(/\/+$/, "");
  const host = rawHost && !/^https?:\/\//i.test(rawHost) ? `https://${rawHost}` : rawHost;
  const doFetch = deps.fetchImpl ?? fetch;

  if (!host) return json({ detail: "Partner agent not configured." }, 503);
  if (!isForwardablePath(pathSegments)) return json({ detail: "Not found." }, 404);

  const search = new URL(req.url).search;
  const target = `${host}/${pathSegments.join("/")}${search}`;

  // FAIL LOUDLY rather than serve the wrong agent. See isSelfTarget().
  if (isSelfTarget(req.url, target, req.headers.get("host"))) {
    console.error(
      `[partner-proxy] PARTNER_AGENT_HOST (${host}) points at THIS service. ` +
        "Refusing to forward: it would make the FAQ agent answer partner questions " +
        "and log them to the FAQ Langfuse project. Point it at the partner agent's " +
        "own host/port (they must not share a port).",
    );
    return json(
      {
        detail:
          "Partner agent misconfigured: PARTNER_AGENT_HOST points at this service itself " +
          "(its own origin), which would route partner requests to the FAQ agent. " +
          "Set it to the partner agent's own host and port.",
      },
      503,
    );
  }

  const headers = new Headers();
  for (const [k, v] of req.headers) {
    if (!STRIP.has(k.toLowerCase())) headers.set(k, v);
  }

  // Service-to-service auth. The partner agent (Service 2) authenticates THIS
  // proxy via a shared secret carried as HTTP Basic. eve's client never uses the
  // Authorization header for session state (its continuationToken rides in the
  // request body/query), so overwriting it here breaks no session. Strip any
  // client-supplied Authorization unconditionally so a browser can't smuggle a
  // credential upstream; add ours only when the secret is configured. With no
  // secret set, the upstream falls back to its own auth (401 in production —
  // fail closed; loopback dev still works via the agent's localDev()).
  headers.delete("authorization");
  const secret = process.env.PARTNER_PROXY_SECRET?.trim();
  if (secret) {
    const basic = Buffer.from(`navio-proxy:${secret}`).toString("base64");
    headers.set("authorization", `Basic ${basic}`);
  }

  const init: RequestInit = { method: req.method, headers, redirect: "manual" };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.arrayBuffer();
  }

  let upstream: Response;
  try {
    upstream = await doFetch(target, init);
  } catch (e) {
    // Surface the real network error: undici wraps it as a generic "fetch failed"
    // whose useful part (ECONNREFUSED, EACCES, …) lives in `cause`.
    const cause = (e as Error & { cause?: Error & { code?: string } }).cause;
    const causeText = cause ? ` (${cause.code ?? ""} ${cause.message})`.trimEnd() : "";
    console.error(`[partner-proxy] fetch to ${target} failed: ${(e as Error).message}${causeText}`);
    return json({ detail: `Upstream unreachable: ${(e as Error).message}${causeText}` }, 502);
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
