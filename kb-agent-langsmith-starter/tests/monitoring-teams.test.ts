import { describe, it, expect, vi } from "vitest";
import { sendTeamsAlert, teamsEnabled } from "../lib/monitoring/teams";
import { toAlertMessage, LangfuseWebhookSchema } from "../lib/monitoring/format-alert";

const RAW_PAYLOAD = {
  id: "evt_1",
  timestamp: "2026-08-19T10:30:00Z",
  type: "monitor-alert",
  payload: {
    monitorId: "m1",
    projectId: "p1",
    permalink: "https://example.test/monitor",
    message: { title: "avg latency crossed alert threshold", body: "detail" },
    severity: "ALERT" as const,
    window: "1h",
  },
};
const msg = toAlertMessage(LangfuseWebhookSchema.parse(RAW_PAYLOAD), "Navio — FAQ");

describe("teamsEnabled", () => {
  it("false when the webhook URL is unset", () => {
    expect(teamsEnabled({} as unknown as NodeJS.ProcessEnv)).toBe(false);
  });
  it("true when set", () => {
    expect(teamsEnabled({ TEAMS_ALERT_WEBHOOK_URL: "https://x.test" } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe("sendTeamsAlert", () => {
  const env = { TEAMS_ALERT_WEBHOOK_URL: "https://teams.example/webhook" } as unknown as NodeJS.ProcessEnv;

  it("posts the Adaptive Card attachments envelope and reports success", async () => {
    const fetchImpl = vi.fn(async () => new Response("1", { status: 200 })) as unknown as typeof fetch;
    const result = await sendTeamsAlert(msg, { fetchImpl, env });
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(env.TEAMS_ALERT_WEBHOOK_URL);
    const body = JSON.parse(init.body as string);
    expect(body.type).toBe("message");
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0].contentType).toBe("application/vnd.microsoft.card.adaptive");
    expect(JSON.stringify(body.attachments[0].content)).toContain(msg.title);
  });

  it("retries once on a 5xx and succeeds on the second attempt", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("err", { status: 503 }))
      .mockResolvedValueOnce(new Response("1", { status: 200 })) as unknown as typeof fetch;
    const result = await sendTeamsAlert(msg, { fetchImpl, env });
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 4xx", async () => {
    const fetchImpl = vi.fn(async () => new Response("bad", { status: 400 })) as unknown as typeof fetch;
    const result = await sendTeamsAlert(msg, { fetchImpl, env });
    expect(result.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports not-configured without calling fetch when the URL is unset", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await sendTeamsAlert(msg, { fetchImpl, env: {} as unknown as NodeJS.ProcessEnv });
    expect(result.ok).toBe(false);
    expect(result.detail).toBe("not configured");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
