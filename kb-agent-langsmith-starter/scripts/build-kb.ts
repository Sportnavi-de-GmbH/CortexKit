/**
 * Build the FAQ knowledge base from the source document.
 *
 *   npm run kb:build
 *
 * Reads   agent/kb/Sportnavi_Knowledge_Base_Checkin_FINAL.docx   (source of truth, never edited)
 * Writes  agent/prompts/kb-v4.md       — the KB as Markdown, embedded verbatim in instructions-v4.md
 *         lib/kb-sources.ts            — every URL the KB cites; the widget shows ONLY these as Quellen
 *
 * The conversion is mechanical: headings and bullets keep their level, hyperlinks
 * become Markdown links with the document's own targets, nothing is summarised.
 * One layout change: an entry's extra source links, which the document puts in
 * paragraphs of their own under "Quellen:", are joined onto that line.
 * After a rebuild, paste kb-v4.md into the DOCUMENT block of instructions-v4.md
 * (tests/kb-v4.test.ts fails until the two match), then `npm run prompt:use v4`.
 *
 * No zip dependency: a .docx is a zip, and Node's zlib inflates its entries.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

const SOURCE = "agent/kb/Sportnavi_Knowledge_Base_Checkin_FINAL.docx";
const KB_OUT = "agent/prompts/kb-v4.md";
const SOURCES_OUT = "lib/kb-sources.ts";

/** Minimal zip reader: central directory → one entry's bytes. */
function readZipEntry(zip: Buffer, name: string): string {
  let eocd = zip.length - 22;
  while (eocd >= 0 && zip.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("not a zip file");
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(p + 10);
    const size = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const entryName = zip.toString("utf8", p + 46, p + 46 + nameLen);
    if (entryName === name) {
      const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(dataStart, dataStart + size);
      return (method === 8 ? inflateRawSync(data) : data).toString("utf8");
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`${name} not found in ${SOURCE}`);
}

const decode = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

const PREFIX: Record<string, string> = {
  Title: "# ",
  Heading1: "## ",
  Heading2: "### ",
  Heading3: "#### ",
  ListBullet: "- ",
};

export function docxToMarkdown(documentXml: string, relsXml: string): string {
  const rels = new Map(
    [...relsXml.matchAll(/<Relationship\b[^>]*>/g)].flatMap((m) => {
      const id = /Id="([^"]+)"/.exec(m[0])?.[1];
      const target = /Target="([^"]+)"/.exec(m[0])?.[1];
      return id && target ? [[id, decode(target)] as const] : [];
    }),
  );
  const body = documentXml.slice(documentXml.indexOf("<w:body>"));
  const lines: string[] = [];
  for (const p of body.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []) {
    const style = /w:pStyle w:val="([^"]+)"/.exec(p)?.[1] ?? "";
    let text = "";
    for (const m of p.matchAll(/<w:hyperlink\b[^>]*r:id="([^"]+)"[^>]*>([\s\S]*?)<\/w:hyperlink>|<w:r[ >][\s\S]*?<\/w:r>/g)) {
      if (m[1]) {
        const label = [...m[2]!.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((t) => decode(t[1]!)).join("");
        const href = rels.get(m[1]);
        text += href ? `[${label}](${href})` : label;
        continue;
      }
      text += [...m[0].matchAll(/<w:t[^>]*>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g)]
        .map((t) => (t[1] !== undefined ? decode(t[1]) : t[0] === "<w:tab/>" ? " " : "\n"))
        .join("");
    }
    text = text.replace(/\s+$/, "");
    if (!text.trim()) {
      lines.push("");
      continue;
    }
    // The document puts an entry's second, third … source on their own lines under
    // "Quellen:" (line breaks in the paragraph, or separate paragraphs). Join them
    // onto that line: same links, same order, but the model then reads every source
    // of the entry in one place — measured, it otherwise cites only the first
    // (3 of 4 two-source answers).
    if (text.startsWith("Quellen:")) text = text.replace(/\s*\n\s*(?=\[[^\]\n]*\]\([^)\s]+\))/g, ", ");
    if (/^\[[^\]\n]*\]\([^)\s]+\)$/.test(text) && lines.at(-1)?.startsWith("Quellen:")) {
      lines[lines.length - 1] += `, ${text}`;
      continue;
    }
    lines.push(style === "Subtitle" ? `_${text}_` : (PREFIX[style] ?? "") + text);
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

/** Every distinct http(s) URL the KB mentions, in first-seen order. */
export function extractKbUrls(markdown: string): string[] {
  const urls = new Set<string>();
  for (const m of markdown.matchAll(/https?:\/\/[^\s)\]>"]+/g)) urls.add(m[0].replace(/[.,;:]+$/, ""));
  return [...urls];
}

function main() {
  const zip = readFileSync(SOURCE);
  const md = docxToMarkdown(readZipEntry(zip, "word/document.xml"), readZipEntry(zip, "word/_rels/document.xml.rels"));
  writeFileSync(KB_OUT, md);
  const urls = extractKbUrls(md);
  writeFileSync(
    SOURCES_OUT,
    `// GENERATED by scripts/build-kb.ts from ${SOURCE} — do not edit by hand.\n` +
      `// Every URL the knowledge base cites. The widget renders a Quelle only if it is\n` +
      `// in this list, so a URL the model invents can never reach the visitor.\n\n` +
      `export const KB_SOURCE_URLS: readonly string[] = ${JSON.stringify(urls, null, 2)};\n`,
  );
  console.log(`✔ ${KB_OUT} (${md.length} chars) · ${SOURCES_OUT} (${urls.length} URLs)`);
}

if (process.argv[1]?.endsWith("build-kb.ts")) main();
