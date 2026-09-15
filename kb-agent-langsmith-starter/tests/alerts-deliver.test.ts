import { describe, it, expect, vi } from "vitest";
import { deliver, transitionMessage, digestMessage, testMessage, TECH_LABEL } from "../lib/monitoring/alerts/deliver";
import { formatTeamsCard, formatEmailHtml } from "../lib/monitoring/format-alert";
import type { AlertRule, Observation, Transition } from "../lib/monitoring/alerts/types";

const rule: AlertRule = { id: "r1", key: "failure_rate", agent: "all", enabled: true, severity: "alert", threshold: 0.1, window_hours: 24, min_samples: 10, params: {}, description: "" };
const obs: Observation = { rule, agent: "faq", subkey: "", status: "breached", observed: 0.15, samples: 20, threshold: 0.1 };
const fired: Transition = { kind: "fired", obs };
const URL = "https://navio-widget.vercel.app/monitoring/alerts";

describe("messages", () => {
  it("fired → ALERT severity, monitoring label, dashboard link, human headline", () => {
    const m = transitionMessage(fired, "Text.", URL);
    expect(m.severity).toBe("ALERT");
    expect(m.projectLabel).toBe("Navio Monitoring");
    expect(m.permalink).toBe(URL);
    expect(m.linkLabel).toBe("Dashboard öffnen");
    expect(m.title).toBe("FAQ-Assistent: viele Anfragen ohne Antwort");
    expect(m.title).not.toMatch(/failure_rate|·faq|p95/);
  });
  it("recovered → an all-clear headline", () => {
    const m = transitionMessage({ kind: "recovered", obs: { ...obs, status: "ok" } }, "x", URL);
    expect(m.severity).toBe("OK");
    expect(m.title).toBe("Entwarnung: FAQ-Assistent antwortet wieder");
  });
  it("the technical facts live in a separate block, not in the human text", () => {
    const m = transitionMessage(fired, "Text.", URL);
    expect(m.facts).toBeUndefined();
    expect(m.techLabel).toBe(TECH_LABEL);
    expect(m.techFacts?.map((f) => f.title)).toEqual(["Regel", "Agent", "Wert", "Grenze", "Fenster", "Turns"]);
    expect(m.techFacts?.[0].value).toBe("failure_rate·faq");
  });
  it("the card renders the technical block under a 'Für das Technik-Team' label", () => {
    const card = formatTeamsCard(transitionMessage(fired, "Text.", URL)) as { attachments: { content: { body: { type: string; text?: string }[] } }[] };
    const body = card.attachments[0].content.body;
    const labelAt = body.findIndex((b) => b.text === TECH_LABEL);
    expect(labelAt).toBeGreaterThan(-1);
    expect(body[labelAt + 1].type).toBe("FactSet");
    const html = formatEmailHtml(transitionMessage(fired, "Text.", URL));
    expect(html).toContain(`<p>${TECH_LABEL}</p>`);
    expect(html).toContain("failure_rate·faq");
  });
  it("warning rule → WARNING", () => {
    expect(transitionMessage({ kind: "fired", obs: { ...obs, rule: { ...rule, severity: "warning" } } }, "x", URL).severity).toBe("WARNING");
  });
  it("digest has a plain-words title, one human fact per observation, and a FactSet", () => {
    const m = digestMessage([obs, { ...obs, agent: "partner", status: "ok", observed: 0.01 }], [], "Lage.", URL);
    expect(m.title).toBe("Statusbericht: 1 Problem(e)");
    expect(m.facts).toHaveLength(2);
    expect(m.facts?.[0].title).toContain("Fehlerrate des FAQ-Assistenten");
    const card = formatTeamsCard(m) as { attachments: { content: { body: { type: string }[] } }[] };
    expect(card.attachments[0].content.body.some((b) => b.type === "FactSet")).toBe(true);
    expect(digestMessage([{ ...obs, status: "ok", observed: 0.01 }], [], "Lage.", URL).title).toBe("Statusbericht: alles in Ordnung");
  });
  it("test message reassures instead of alarming", () => {
    const m = testMessage(URL);
    expect(m.title).toMatch(/Testalarm/);
    expect(m.detail).toBe("Dies ist ein Testalarm. Alles funktioniert. Keine Aktion nötig.");
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
