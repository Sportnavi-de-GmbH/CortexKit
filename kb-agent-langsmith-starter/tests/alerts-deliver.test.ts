import { describe, it, expect, vi } from "vitest";
import { deliver, transitionMessage, digestMessage, testMessage } from "../lib/monitoring/alerts/deliver";
import { formatTeamsCard } from "../lib/monitoring/format-alert";
import type { AlertRule, Observation, Transition } from "../lib/monitoring/alerts/types";

const rule: AlertRule = { id: "r1", key: "failure_rate", agent: "all", enabled: true, severity: "alert", threshold: 0.1, window_hours: 24, min_samples: 10, params: {}, description: "" };
const obs: Observation = { rule, agent: "faq", subkey: "", status: "breached", observed: 0.15, samples: 20, threshold: 0.1 };
const fired: Transition = { kind: "fired", obs };
const URL = "https://navio-widget.vercel.app/monitoring/alerts";

describe("messages", () => {
  it("fired → ALERT severity, monitoring label, dashboard link, fact rows", () => {
    const m = transitionMessage(fired, "Text.", URL);
    expect(m.severity).toBe("ALERT");
    expect(m.projectLabel).toBe("Navio Monitoring");
    expect(m.permalink).toBe(URL);
    expect(m.linkLabel).toBe("Dashboard öffnen");
    expect(m.facts?.map((f) => f.title)).toEqual(["Wert", "Grenze", "Fenster", "Turns"]);
    expect(m.title).toBe("Fehlerrate · FAQ");
  });
  it("warning rule → WARNING; recovered → OK", () => {
    expect(transitionMessage({ kind: "fired", obs: { ...obs, rule: { ...rule, severity: "warning" } } }, "x", URL).severity).toBe("WARNING");
    expect(transitionMessage({ kind: "recovered", obs: { ...obs, status: "ok" } }, "x", URL).severity).toBe("OK");
  });
  it("digest has one fact per observation and renders a FactSet", () => {
    const m = digestMessage([obs, { ...obs, agent: "partner", status: "ok", observed: 0.01 }], [], "Lage.", URL);
    expect(m.facts).toHaveLength(2);
    const card = formatTeamsCard(m) as { attachments: { content: { body: { type: string }[] } }[] };
    expect(card.attachments[0].content.body.some((b) => b.type === "FactSet")).toBe(true);
  });
  it("test message is labelled", () => {
    expect(testMessage(URL).title).toMatch(/Testalarm/);
  });
});

describe("deliver", () => {
  const env = { TEAMS_ALERT_WEBHOOK_URL: "https://teams.example/hook" } as unknown as NodeJS.ProcessEnv;
  it("sends to teams, skips email when not configured", async () => {
    const fetchImpl = vi.fn(async () => new Response("1", { status: 200 })) as unknown as typeof fetch;
    const d = await deliver(transitionMessage(fired, "t", URL), { teams: true, email: true }, { fetchImpl, env });
    expect(d.teams).toBe("sent");
    expect(d.email).toBe("skipped");
  });
  it("records a teams failure without throwing", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 400 })) as unknown as typeof fetch;
    const d = await deliver(transitionMessage(fired, "t", URL), { teams: true, email: false }, { fetchImpl, env });
    expect(d.teams).toMatch(/^failed: HTTP 400/);
    expect(d.email).toBe("skipped");
  });
  it("channel false ⇒ skipped without a call", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const d = await deliver(transitionMessage(fired, "t", URL), { teams: false, email: false }, { fetchImpl, env });
    expect(d).toEqual({ teams: "skipped", email: "skipped" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
