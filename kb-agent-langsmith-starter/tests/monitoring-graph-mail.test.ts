import { describe, it, expect, vi } from "vitest";
import { toAlertMessage, LangfuseWebhookSchema } from "../lib/monitoring/format-alert";

// graph-mail.ts reads its Azure AD credentials as module-level constants (mirroring
// lib/contact/salesforce.ts's pattern), so each test that needs a specific
// configuration re-imports a fresh module instance after setting process.env — this
// also gives every test its own token cache, avoiding cross-test pollution. freshModule()
// always deletes and re-sets every relevant key, so tests need no separate env teardown.

const REQUIRED_ENV = {
  MS_GRAPH_TENANT_ID: "tenant-1",
  MS_GRAPH_CLIENT_ID: "client-1",
  MS_GRAPH_CLIENT_SECRET: "secret-1",
  MS_GRAPH_SENDER_UPN: "alerts@sportnavi.de",
  ALERT_EMAIL_TO: "oncall@sportnavi.de",
};

const ENV_KEYS = [...Object.keys(REQUIRED_ENV), "MS_GRAPH_TIMEOUT_SEC"] as const;

async function freshModule(overrides: Partial<Record<string, string>> = {}) {
  vi.resetModules();
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, REQUIRED_ENV, overrides);
  return import("../lib/monitoring/graph-mail");
}

const msg = toAlertMessage(
  LangfuseWebhookSchema.parse({
    id: "evt_1",
    timestamp: "2026-08-19T10:30:00Z",
    type: "monitor-alert",
    payload: {
      monitorId: "m1",
      projectId: "p1",
      message: { title: "daily spend exceeded threshold", body: "detail" },
      severity: "ALERT",
      window: "1d",
    },
  }),
  "Navio — Partner",
);

const TOKEN_URL = "https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token";
const SEND_URL = "https://graph.microsoft.com/v1.0/users/alerts%40sportnavi.de/sendMail";

function tokenResponse(token = "tok-1"): Response {
  return new Response(JSON.stringify({ access_token: token }), { status: 200 });
}

describe("graphMailEnabled / alertRecipientsConfigured", () => {
  it("disabled without full Azure AD credentials", async () => {
    const mod = await freshModule({ MS_GRAPH_CLIENT_SECRET: "" });
    expect(mod.graphMailEnabled()).toBe(false);
  });

  it("enabled with all four credentials present", async () => {
    const mod = await freshModule();
    expect(mod.graphMailEnabled()).toBe(true);
  });

  it("sendAlertEmail no-ops without calling fetch when not configured", async () => {
    const mod = await freshModule({ MS_GRAPH_CLIENT_SECRET: "" });
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await mod.sendAlertEmail(msg, { fetchImpl });
    expect(result).toEqual({ ok: false, detail: "not configured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports missing recipients distinctly from missing credentials", async () => {
    const mod = await freshModule({ ALERT_EMAIL_TO: "" });
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await mod.sendAlertEmail(msg, { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/recipients/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("sendAlertEmail — happy path", () => {
  it("acquires a token then sends, treating 202 as success", async () => {
    const mod = await freshModule();
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === TOKEN_URL) return tokenResponse();
      if (url === SEND_URL) return new Response(null, { status: 202 });
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;

    const result = await mod.sendAlertEmail(msg, { fetchImpl });
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const sendCall = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
      ([url]) => url === SEND_URL,
    );
    const init = sendCall![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-1");
    const body = JSON.parse(init.body as string);
    expect(body.message.toRecipients).toEqual([{ emailAddress: { address: "oncall@sportnavi.de" } }]);
    expect(body.message.subject).toContain(msg.title);
  });

  it("caches the token across two calls (only one token fetch)", async () => {
    const mod = await freshModule();
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === TOKEN_URL) return tokenResponse();
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;

    await mod.sendAlertEmail(msg, { fetchImpl });
    await mod.sendAlertEmail(msg, { fetchImpl });

    const tokenCalls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([url]) => url === TOKEN_URL,
    );
    expect(tokenCalls).toHaveLength(1);
  });

  it("collapses concurrent token refreshes into a single request", async () => {
    const mod = await freshModule();
    let tokenCalls = 0;
    let releaseToken: () => void = () => {};
    const gate = new Promise<void>((r) => (releaseToken = r));

    const fetchImpl = vi.fn(async (url: string) => {
      if (url === TOKEN_URL) {
        tokenCalls += 1;
        await gate; // hold the first token request open until both sends are in flight
        return tokenResponse();
      }
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;

    const first = mod.sendAlertEmail(msg, { fetchImpl });
    const second = mod.sendAlertEmail(msg, { fetchImpl });
    releaseToken();
    const [r1, r2] = await Promise.all([first, second]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(tokenCalls).toBe(1);
  });
});

describe("sendAlertEmail — error handling", () => {
  it("retries once after a 401 by forcing a fresh token, then succeeds", async () => {
    const mod = await freshModule();
    let sendAttempts = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === TOKEN_URL) return tokenResponse(`tok-${Math.random()}`);
      sendAttempts += 1;
      if (sendAttempts === 1) return new Response("expired", { status: 401 });
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;

    const result = await mod.sendAlertEmail(msg, { fetchImpl });
    expect(result.ok).toBe(true);
    expect(sendAttempts).toBe(2);
    const tokenCalls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([url]) => url === TOKEN_URL,
    );
    expect(tokenCalls).toHaveLength(2); // initial + forced refresh after the 401
  });

  it("does not retry a 403 (treated as a permission problem, not transient)", async () => {
    const mod = await freshModule();
    let sendAttempts = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === TOKEN_URL) return tokenResponse();
      sendAttempts += 1;
      return new Response("Forbidden", { status: 403 });
    }) as unknown as typeof fetch;

    const result = await mod.sendAlertEmail(msg, { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("403");
    expect(sendAttempts).toBe(1);
  });

  it("surfaces an auth error without throwing when the token endpoint fails", async () => {
    const mod = await freshModule();
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === TOKEN_URL) return new Response("bad creds", { status: 401 });
      throw new Error("should not reach sendMail");
    }) as unknown as typeof fetch;

    const result = await mod.sendAlertEmail(msg, { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/auth error/i);
  });
});
