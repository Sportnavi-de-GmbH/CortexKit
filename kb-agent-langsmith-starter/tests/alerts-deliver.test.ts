import { describe, it, expect, vi } from "vitest";
import { deliver, transitionMessage, digestMessage, testMessage, TECH_LABEL } from "../lib/monitoring/alerts/deliver";
import { formatTeamsCard, formatEmailHtml, formatEmailSubject } from "../lib/monitoring/format-alert";
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
    expect(m.title).toBe("1 Problem"); // the severity word already prefixes header and subject
    expect(m.facts).toHaveLength(2);
    expect(m.facts?.[0].title).toContain("Fehlerrate des FAQ-Assistenten");
    const card = formatTeamsCard(m) as { attachments: { content: { body: { type: string }[] } }[] };
    expect(card.attachments[0].content.body.some((b) => b.type === "FactSet")).toBe(true);
    expect(digestMessage([{ ...obs, status: "ok", observed: 0.01 }], [], "Lage.", URL).title).toBe("Alles in Ordnung");
    expect(digestMessage([obs, { ...obs, agent: "partner" }], [], "Lage.", URL).title).toBe("2 Probleme");
    // "Alles in Ordnung" is only claimed when every rule was measured.
    expect(digestMessage([{ ...obs, status: "ok", observed: 0.01 }, { ...obs, agent: "partner", status: "skipped", observed: null }], [], "Lage.", URL).title).toBe("Keine Probleme gefunden");
    expect(digestMessage([{ ...obs, status: "ok", observed: 0.01 }], ["cost_spike·faq"], "Lage.", URL).title).toBe("Keine Probleme gefunden");
    const subject = formatEmailSubject(digestMessage([{ ...obs, status: "ok", observed: 0.01 }], [], "Lage.", URL));
    expect(subject).toBe("[Navio] Statusbericht: Alles in Ordnung");
  });
  it("the card chrome speaks German and keeps the ISO time in the technical block", () => {
    const m = transitionMessage(fired, "Text.", URL);
    expect(m.humanSeverity).toBe("Alarm");
    expect(formatEmailSubject(m)).toBe("[Navio] Alarm: FAQ-Assistent: viele Anfragen ohne Antwort");
    expect(transitionMessage({ kind: "recovered", obs: { ...obs, status: "ok" } }, "x", URL).humanSeverity).toBe("Entwarnung / alles in Ordnung");
    const card = formatTeamsCard(m) as { attachments: { content: { body: { type: string; text?: string; facts?: { title: string; value: string }[] }[] } }[] };
    const body = card.attachments[0].content.body;
    expect(body[0].text).toContain("Alarm");
    expect(body[0].text).not.toMatch(/ALERT/);
    const last = body[body.length - 1];
    expect(last.text).not.toMatch(/window|\d{4}-\d{2}-\d{2}T/);
    expect(last.text).toMatch(/^\d{2}\.\d{2}\. \d{2}:\d{2}$/);
    const tech = body.filter((b) => b.type === "FactSet").pop();
    expect(tech?.facts?.some((f) => f.title === "Zeitpunkt" && f.value === m.timestampIso)).toBe(true);
  });
  it("the digest facts read in plain words, never a raw note or a multiplier", () => {
    const spike = { ...obs, rule: { ...rule, key: "cost_spike" as const, threshold: 3 }, status: "skipped" as const, observed: null, note: "Aufwärmphase (warmup): 0/7 Tage Basis" };
    const m = digestMessage([spike], [], "Lage.", URL);
    expect(m.facts?.[0].value).toContain("Noch nicht genug Vergleichstage gesammelt (0 von 7)");
    expect(m.facts?.[0].value).not.toMatch(/warmup/);
    const hot = digestMessage([{ ...obs, rule: { ...rule, key: "cost_spike" as const, threshold: 3 }, observed: 3.2, note: "24h 3.20 $ vs Basis 1.00 $/Tag" }], [], "Lage.", URL);
    expect(hot.facts?.[0].value).toContain("3,2-mal so hoch wie an einem normalen Tag");
    expect(hot.facts?.[0].value).toContain("(erlaubt: bis 3-mal)"); // short limit: the value just set the unit
    expect(hot.facts?.[0].value).not.toMatch(/erlaubt bis 3-mal so hoch/);
    expect(hot.facts?.[0].value).not.toMatch(/× Basis/);
    expect(m.facts?.[0].value).not.toMatch(/erlaubt bis/);
    expect(m.facts?.[0].value.startsWith("nicht gemessen")).toBe(true);
  });
  it("test message reassures instead of alarming", () => {
    const m = testMessage(URL);
    expect(m.title).toMatch(/Testalarm/);
    expect(m.detail).toBe("Dies ist ein Testalarm. Alles funktioniert. Keine Aktion nötig.");
    expect(m.humanSeverity).toBe("Test");
  });
  it("a digest is a status report unless something is breached", () => {
    expect(digestMessage([{ ...obs, status: "ok", observed: 0.01 }], [], "Lage.", URL).humanSeverity).toBe("Statusbericht");
    expect(digestMessage([obs], [], "Lage.", URL).humanSeverity).toBe("Alarm");
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
