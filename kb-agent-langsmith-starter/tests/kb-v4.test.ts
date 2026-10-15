/**
 * Prompt v4 — the new knowledge base (Sportnavi_Wissensdatenbank_mit_Quellen.docx)
 * and its contract with the widget.
 *
 * The failures this pins are all silent: a rules edit that drifts from the KB, a
 * KB rebuild that is never pasted into the prompt, a source URL the widget would
 * refuse to show, a starter question with no KB entry behind it, and partner
 * behaviour creeping back into the rules.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { FAQ_STARTER_QUESTIONS } from "../components/navio/starter-questions";
import { KB_SOURCE_URLS } from "../lib/kb-sources";
import { docxToMarkdown, extractKbUrls } from "../scripts/build-kb";

// Line endings normalised: a Windows checkout (core.autocrlf) turns these into CRLF.
const read = (path: string) => readFileSync(path, "utf8").replace(/
/g, "
");
const kb = read("agent/prompts/kb-v4.md");
const prompt = read("agent/prompts/instructions-v4.md");
const OPEN = "<<< DOCUMENT: kb-v4.md >>>";
const CLOSE = "<<< END OF kb-v4.md >>>";
const rules = prompt.slice(0, prompt.indexOf(OPEN)) + prompt.slice(prompt.indexOf(CLOSE));

describe("the knowledge base inside prompt v4", () => {
  it("is kb-v4.md byte for byte", () => {
    const block = prompt.slice(prompt.indexOf(OPEN) + OPEN.length, prompt.indexOf(CLOSE));
    expect(block.trim()).toBe(kb.trim());
  });

  it("keeps the document whole: four parts, every Quellen line", () => {
    for (const part of ["Teil 1", "Teil 2", "Teil 3", "Teil 4"]) expect(kb).toContain(`## ${part}`);
    expect(kb.match(/^#### /gm)?.length).toBe(167);
    expect(kb.match(/^Quellen:/gm)?.length).toBe(87);
  });

  it("is the active prompt", () => {
    expect(read("agent/instructions.md")).toBe(prompt);
  });
});

describe("the source allowlist the widget trusts", () => {
  it("is exactly the URLs the KB cites", () => {
    expect([...KB_SOURCE_URLS]).toEqual(extractKbUrls(kb));
  });

  it("covers every URL in a Quellen line", () => {
    const quellen = kb.split("\n").filter((l) => l.startsWith("Quellen:"));
    for (const url of extractKbUrls(quellen.join("\n"))) expect(KB_SOURCE_URLS).toContain(url);
  });

  it("keeps every source of an entry on its one Quellen line", () => {
    const lines = kb.split("\n");
    const stray = lines.filter((l, i) => /^\[[^\]]*\]\([^)]+\)$/.test(l) && lines[i - 1]?.startsWith("Quellen:"));
    expect(stray).toEqual([]);
    expect(kb).toContain(
      "Quellen: [https://www.sportnavi.de/fuer-unternehmen/](https://www.sportnavi.de/fuer-unternehmen/), [https://www.sportnavi.de/sportnavi-app/](https://www.sportnavi.de/sportnavi-app/)",
    );
  });
});

describe("the docx → markdown conversion", () => {
  it("keeps heading levels, bullets and hyperlink targets", () => {
    const xml =
      '<w:body><w:p><w:pPr><w:pStyle w:val="Heading3"/></w:pPr><w:r><w:t>Frage?</w:t></w:r></w:p>' +
      '<w:p><w:pPr><w:pStyle w:val="ListBullet"/></w:pPr><w:r><w:t xml:space="preserve">Punkt &amp; mehr</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t xml:space="preserve">Quellen: </w:t></w:r><w:hyperlink r:id="rId9"><w:r><w:t>Link</w:t></w:r></w:hyperlink></w:p></w:body>';
    const rels = '<Relationship Id="rId9" Type="hyperlink" Target="https://www.sportnavi.de/faq/?a=1&amp;b=2"/>';
    expect(docxToMarkdown(xml, rels)).toBe(
      "#### Frage?\n- Punkt & mehr\nQuellen: [Link](https://www.sportnavi.de/faq/?a=1&b=2)\n",
    );
  });

  it("joins an entry's extra source paragraphs onto its Quellen line", () => {
    const link = (id: string) => `<w:hyperlink r:id="${id}"><w:r><w:t>${id}</w:t></w:r></w:hyperlink>`;
    const xml =
      `<w:body><w:p><w:r><w:t xml:space="preserve">Quellen: </w:t></w:r>${link("a")}</w:p>` +
      `<w:p>${link("b")}</w:p><w:p><w:r><w:t>Weiter.</w:t></w:r></w:p></w:body>`;
    const rels = '<Relationship Id="a" Target="https://x.de/a/"/><Relationship Id="b" Target="https://x.de/b/"/>';
    expect(docxToMarkdown(xml, rels)).toBe("Quellen: [a](https://x.de/a/), [b](https://x.de/b/)\nWeiter.\n");
  });

  it("joins extra sources separated by a line break inside the Quellen paragraph", () => {
    const xml =
      '<w:body><w:p><w:r><w:t xml:space="preserve">Quellen: </w:t></w:r><w:hyperlink r:id="a"><w:r><w:t>a</w:t></w:r></w:hyperlink>' +
      '<w:r><w:br/></w:r><w:hyperlink r:id="b"><w:r><w:t>b</w:t></w:r></w:hyperlink></w:p></w:body>';
    const rels = '<Relationship Id="a" Target="https://x.de/a/"/><Relationship Id="b" Target="https://x.de/b/"/>';
    expect(docxToMarkdown(xml, rels)).toBe("Quellen: [a](https://x.de/a/), [b](https://x.de/b/)\n");
  });
});

describe("prompt v4 rules — FAQ and support only", () => {
  it("has no Partner-Finder, partner or booking buttons", () => {
    expect(rules).not.toMatch(/\[\[action:(partner|meeting)\]\]/);
    expect(rules).not.toMatch(/Partner-Finder|Partner finden/);
  });

  it("has no partner-acquisition script", () => {
    expect(rules).not.toMatch(/Was wünschst du dir pro Check-in|PARTNER — Studios/);
  });

  it("never offers a Termin — only forbids it", () => {
    for (const line of rules.split("\n").filter((l) => /Termin/.test(l))) {
      expect(line).toMatch(/KEINE Termine|KEIN TERMIN|Termin buchen", "Terminbuchung"|ohne Terminbuchung|Kontakt\/Terminbuchung|NIE eine\s*$|Terminbuchung an\./);
    }
  });

  it("asks for Quellen and tells the model where they come from", () => {
    expect(rules).toContain("=== 7A. QUELLEN");
    expect(rules).toContain("[[source:URL]]");
  });
});

describe("starter questions on the welcome screen", () => {
  it("are four real questions from the KB", () => {
    expect(FAQ_STARTER_QUESTIONS).toHaveLength(4);
    for (const q of FAQ_STARTER_QUESTIONS) expect(kb).toContain(`#### ${q}\n`);
  });

  it("drop 'Partner werden' and anything partner-related", () => {
    for (const q of FAQ_STARTER_QUESTIONS) expect(q).not.toMatch(/Partner/i);
  });

  it("stay short enough for the pill layout", () => {
    for (const q of FAQ_STARTER_QUESTIONS) expect(q.length).toBeLessThanOrEqual(36);
  });
});
