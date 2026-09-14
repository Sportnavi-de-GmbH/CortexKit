import { describe, it, expect } from "vitest";
import { formatAddress, parseV3Answer, pickCategories, readV3Result, type V3Recommendation, type V3Task } from "../lib/v3-answer";

const rec = (rank: number, name: string, over: Partial<V3Recommendation> = {}): V3Recommendation => ({
  rank, id: rank * 100, name, city: "Dortmund", role: "target", distanceKm: 0,
  card: { logoUrl: null, street: null, postalCode: null, email: null, phone: null, websiteUrl: "https://x.de", mapsUrl: null, tags: [], courses: [] },
  ...over,
});

// Verbatim shape of a real V3 answer (2026-09-14): task heading, bold intro,
// bold numbered headings with two trailing spaces, 1–2 sentences each.
const TWO_TASKS = [
  "**Tennis in Dortmund**",
  "**Ich habe passende Angebote in Dortmund gefunden.**",
  "",
  "**1. Sportbox - Dortmund — Dortmund**  ",
  "Bietet Tennisplätze und Racket-Sport in zentraler Lage.",
  "Kontakt: [Website](https://sportbox.de), Telefon: +49231",
  "",
  "**2. Fitness Jump Dortmund — Dortmund**  ",
  "Vielfältige Fitnessmöglichkeiten, die dir helfen, deine Tennisfähigkeiten zu verbessern.",
  "",
  "**Boxen in Berlin**",
  "**Ich habe passende Angebote in Berlin und der näheren Umgebung gefunden.**",
  "",
  "**1. Boxclub Berlin — Berlin**  ",
  "Klassisches Boxtraining für Anfänger.",
  "",
  "(Notiert für danach: Klettern in Köln – sag einfach Bescheid, dann suche ich weiter.)",
].join("\n");

const tasks: V3Task[] = [
  { label: "Tennis in Dortmund", recommendations: [rec(1, "Sportbox - Dortmund"), rec(2, "Fitness Jump Dortmund")] },
  { label: "Boxen in Berlin", recommendations: [rec(1, "Boxclub Berlin", { city: "Berlin" })] },
];

describe("parseV3Answer", () => {
  it("splits a multi-task answer into labelled sections with intro, one item per recommendation, and trailing text", () => {
    const sections = parseV3Answer(TWO_TASKS, tasks)!;
    expect(sections.map((s) => s.label)).toEqual(["Tennis in Dortmund", "Boxen in Berlin", null]);
    const t = sections[0]!;
    expect(t.intro).toBe("**Ich habe passende Angebote in Dortmund gefunden.**");
    expect(t.items).toHaveLength(2);
    expect(t.items[0]).toMatchObject({ rank: 1, heading: "Sportbox - Dortmund — Dortmund", recommendation: tasks[0]!.recommendations[0] });
    // the "Kontakt:" line is dropped — the card shows those facts as chips
    expect(t.items[0]!.reason).toBe("Bietet Tennisplätze und Racket-Sport in zentraler Lage.");
    expect(t.items[1]!.reason).toBe("Vielfältige Fitnessmöglichkeiten, die dir helfen, deine Tennisfähigkeiten zu verbessern.");
    expect(sections[1]!.items[0]!.recommendation).toBe(tasks[1]!.recommendations[0]);
    // the deferred note is not a section of any task: rendered as plain trailing text
    expect(sections[2]).toMatchObject({ label: null, intro: "(Notiert für danach: Klettern in Köln – sag einfach Bescheid, dann suche ich weiter.)", items: [] });
  });

  it("a single-task answer (no task heading) becomes one unlabelled section", () => {
    const text = "**Ich habe passende Angebote in Bochum gefunden.**\n\n**1. Yogability — Bochum**  \nTolle Yogakurse.\n\n**2. RuhrFital — Bochum**  \nAuch gut.";
    const s = parseV3Answer(text, [{ label: "Yoga in Bochum", recommendations: [rec(1, "Yogability"), rec(2, "RuhrFital")] }]);
    expect(s).toHaveLength(1);
    expect(s![0]!.label).toBeNull();
    expect(s![0]!.items.map((i) => i.recommendation?.name)).toEqual(["Yogability", "RuhrFital"]);
  });

  it("an item whose rank has no recommendation keeps its full text (incl. Kontakt line) but no card", () => {
    const text = "**Intro**\n\n**1. A — X**  \nwhy a\n\n**2. B — X**  \nwhy b\nKontakt: 0231";
    const s = parseV3Answer(text, [{ label: "L", recommendations: [rec(1, "A")] }]);
    expect(s![0]!.items[1]).toMatchObject({ rank: 2, recommendation: null, reason: "why b\nKontakt: 0231" });
  });

  it("returns null when the text has no numbered headings at all (render as plain markdown)", () => {
    expect(parseV3Answer("Leider nichts gefunden – versuch es mit einer anderen Stadt.", [{ label: "L", recommendations: [] }])).toBeNull();
  });

  it("a heading with the sentence on the same line still splits heading and reason", () => {
    const text = "**1. A — X** (weil es passt)";
    const s = parseV3Answer(text, [{ label: "L", recommendations: [rec(1, "A")] }]);
    expect(s![0]!.items[0]).toMatchObject({ heading: "A — X", reason: "(weil es passt)" });
  });
});

describe("readV3Result", () => {
  it("accepts the adapter's result envelope and rejects anything else", () => {
    expect(readV3Result({ kind: "v3-tasks", tasks })).toEqual(tasks);
    expect(readV3Result(undefined)).toBeNull();
    expect(readV3Result({ kind: "other" })).toBeNull();
    expect(readV3Result({ kind: "v3-tasks", tasks: "nope" })).toBeNull();
  });
});

describe("card helpers", () => {
  it("pickCategories prefers title-cased tags, dedupes, falls back to courses, caps at 3", () => {
    expect(pickCategories(["physiotherapie", "ladies-kickboxing", "Physiotherapie"], ["Massage"])).toEqual(["Physiotherapie", "Ladies kickboxing", "Massage"]);
    expect(pickCategories([], ["A | B".split(" | ")[0]!, "B", "C", "D"])).toEqual(["A", "B", "C"]);
  });
  it("formatAddress does not repeat a postal code / city the street already carries", () => {
    const rec = { rank: 1, id: 1, name: "n", city: "Essen", role: "target" as const, distanceKm: 0, card: { logoUrl: null, street: null, postalCode: null, email: null, phone: null, websiteUrl: null, mapsUrl: null, tags: [], courses: [] } };
    expect(formatAddress("Frintroper Straße 407, 45359 Essen", "45359", rec)).toBe("Frintroper Straße 407, 45359 Essen");
    expect(formatAddress("Frintroper Straße 407", "45359", rec)).toBe("Frintroper Straße 407, 45359 Essen");
    expect(formatAddress(null, "45359", rec)).toBeNull();
  });
});
