import { describe, it, expect, vi } from "vitest";
import { createHmac, randomUUID } from "node:crypto";

// relay.ts statically imports graph-mail.ts, whose Azure AD credentials are read as
// module-level constants at import time (see monitoring-graph-mail.test.ts). So tests
// that need email "configured" re-import a fresh module after setting process.env;
// tests that don't care about email just import once with no Graph env set (disabled,
// which is fine — those tests never reach the fan-out step).

const GRAPH_ENV_KEYS = [
  "MS_GRAPH_TENANT_ID",
  "MS_GRAPH_CLIENT_ID",
  "MS_GRAPH_CLIENT_SECRET",
  "MS_GRAPH_SENDER_UPN",
  "ALERT_EMAIL_TO",
] as const;

async function freshRelay(graphOverrides: Partial<Record<string, string>> = {}) {
  vi.resetModules();
  for (const key of GRAPH_ENV_KEYS) delete process.env[key];
  Object.assign(process.env, graphOverrides);
  const mod = await import("../lib/monitoring/relay");
  return mod.handleAlertWebhook;
}

const SECRET = "s3cret";

function sign(secret: string, timestamp: number, rawBody: string): string {
  const sig = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
  return `t=${timestamp},v1=${sig}`;
}

function payload(overrides: { id?: string; severity?: string } = {}) {
  return JSON.stringify({
    id: overrides.id ?? randomUUID(),
    timestamp: "2026-08-19T10:30:00Z",
    type: "monitor-alert",
    apiVersion: "v1",
    payload: {
      monitorId: "m1",
      projectId: "p1",
      permalink: "https://sportnavi-langfuse.sportnavi.de/monitor/m1",
      message: { title: "avg latency crossed alert threshold", body: "detail" },
      severity: overrides.severity ?? "ALERT",
      window: "1h",
    },
  });
}

function signedRequest(
  rawBody: string,
  opts: { secret?: string; badSignature?: boolean; contentLength?: string } = {},
): Request {
  const now = Math.floor(Date.now() / 1000);
  const header = opts.badSignature
    ? "t=1,v1=deadbeef"
    : sign(opts.secret ?? SECRET, now, rawBody);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-langfuse-signature": header,
  };
  if (opts.contentLength) headers["content-length"] = opts.contentLength;
  return new Request("http://localhost/api/monitoring/alerts/faq", {
    method: "POST",
    body: rawBody,
    headers,
  });
}

describe("handleAlertWebhook — gating", () => {
  it("no-ops with 200 when the project secret is unset, without touching Teams/email", async () => {
    const handle = await freshRelay();
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const res = await handle(signedRequest(payload()), "faq", { fetchImpl, env: {} as NodeJS.ProcessEnv });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: "not configured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an invalid signature with 401, without touching Teams/email", async () => {
    const handle = await freshRelay();
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const body = payload();
    const req = signedRequest(body, { badSignature: true });
    const res = await handle(req, "faq", {
      fetchImpl,
      env: { LANGFUSE_ALERT_WEBHOOK_SECRET_FAQ: SECRET } as unknown as NodeJS.ProcessEnv,
    });
    expect(res.status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an oversized payload with 413 before reading the signature", async () => {
    const handle = await freshRelay();
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const body = payload();
    const req = signedRequest(body, { contentLength: "999999999" });
    const res = await handle(req, "faq", {
      fetchImpl,
      env: { LANGFUSE_ALERT_WEBHOOK_SECRET_FAQ: SECRET } as unknown as NodeJS.ProcessEnv,
    });
    expect(res.status).toBe(413);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts a verified but unrecognized payload shape as a 200 skip (never a failure)", async () => {
    const handle = await freshRelay();
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const body = JSON.stringify({ not: "a langfuse payload" });
    const req = signedRequest(body);
    const res = await handle(req, "faq", {
      fetchImpl,
      env: { LANGFUSE_ALERT_WEBHOOK_SECRET_FAQ: SECRET } as unknown as NodeJS.ProcessEnv,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: "unrecognized payload" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("dedupes a replayed event id (Langfuse's own retry) without a second delivery", async () => {
    const handle = await freshRelay(); // email/Teams both unconfigured — fine, only dedup matters
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const id = randomUUID();
    const body = payload({ id });
    const env = { LANGFUSE_ALERT_WEBHOOK_SECRET_FAQ: SECRET } as unknown as NodeJS.ProcessEnv;

    const first = await handle(signedRequest(body), "faq", { fetchImpl, env });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true });

    const second = await handle(signedRequest(body), "faq", { fetchImpl, env });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true, deduped: true });
  });
});

describe("handleAlertWebhook — fan-out", () => {
  it("delivers to both channels and reports each independently", async () => {
    const handle = await freshRelay({
      MS_GRAPH_TENANT_ID: "t1",
      MS_GRAPH_CLIENT_ID: "c1",
      MS_GRAPH_CLIENT_SECRET: "s1",
      MS_GRAPH_SENDER_UPN: "alerts@sportnavi.de",
      ALERT_EMAIL_TO: "oncall@sportnavi.de",
    });
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("login.microsoftonline.com")) {
        return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      }
      if (url.includes("graph.microsoft.com")) return new Response(null, { status: 202 });
      if (url === "https://teams.example/webhook") return new Response("1", { status: 200 });
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;

    const env = {
      LANGFUSE_ALERT_WEBHOOK_SECRET_FAQ: SECRET,
      TEAMS_ALERT_WEBHOOK_URL: "https://teams.example/webhook",
      ALERT_EMAIL_TO: "oncall@sportnavi.de",
    } as unknown as NodeJS.ProcessEnv;

    const res = await handle(signedRequest(payload()), "faq", { fetchImpl, env });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, delivered: { teams: "sent", email: "sent" } });
  });

  it("one channel failing does not block the other, and the response is still 200", async () => {
    const handle = await freshRelay({
      MS_GRAPH_TENANT_ID: "t1",
      MS_GRAPH_CLIENT_ID: "c1",
      MS_GRAPH_CLIENT_SECRET: "s1",
      MS_GRAPH_SENDER_UPN: "alerts@sportnavi.de",
      ALERT_EMAIL_TO: "oncall@sportnavi.de",
    });
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("login.microsoftonline.com")) {
        return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      }
      if (url.includes("graph.microsoft.com")) return new Response("forbidden", { status: 403 });
      if (url === "https://teams.example/webhook") return new Response("1", { status: 200 });
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;

    const env = {
      LANGFUSE_ALERT_WEBHOOK_SECRET_FAQ: SECRET,
      TEAMS_ALERT_WEBHOOK_URL: "https://teams.example/webhook",
      ALERT_EMAIL_TO: "oncall@sportnavi.de",
    } as unknown as NodeJS.ProcessEnv;

    const res = await handle(signedRequest(payload()), "faq", { fetchImpl, env });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, delivered: { teams: "sent", email: "failed" } });
  });

  it("reports skipped (not failed) for a channel that is simply unconfigured", async () => {
    const handle = await freshRelay(); // no Graph env — email unconfigured
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === "https://teams.example/webhook") return new Response("1", { status: 200 });
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;

    const env = {
      LANGFUSE_ALERT_WEBHOOK_SECRET_FAQ: SECRET,
      TEAMS_ALERT_WEBHOOK_URL: "https://teams.example/webhook",
    } as unknown as NodeJS.ProcessEnv;

    const res = await handle(signedRequest(payload()), "faq", { fetchImpl, env });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, delivered: { teams: "sent", email: "skipped" } });
  });
});
