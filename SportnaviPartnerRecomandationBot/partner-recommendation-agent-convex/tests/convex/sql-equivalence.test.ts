/**
 * tests/convex/sql-equivalence.test.ts
 *
 * Pins the four pieces of Postgres this migration had to reimplement in
 * TypeScript. These are the highest-value tests in the Convex build, because
 * every one of them can drift SILENTLY: a stemmer that stops matching, a
 * trigram score that shifts, or a slug that changes shape would not throw —
 * it would just make the Convex agent retrieve different partners from the
 * Supabase agent, and the whole benchmark would quietly stop being an
 * apples-to-apples comparison.
 *
 * What is pinned:
 *   slugify_tag(text)                 -> convex/lib/slugify.ts
 *   pg_trgm similarity(a, b)          -> convex/lib/trigram.ts
 *   to_tsvector('german', text)       -> convex/lib/germanFts.ts
 *   websearch_to_tsquery + ts_rank    -> convex/lib/germanFts.ts
 *   the RRF fusion in match_partners  -> convex/lib/rrf.ts
 *
 * These modules import nothing from convex/_generated, so this suite runs with
 * no deployment and no secrets — same as the rest of `npm test`.
 */
import { describe, expect, it } from "vitest";

import { slugifyTag } from "../../convex/lib/slugify";
import { trigramSimilarity, trigrams } from "../../convex/lib/trigram";
import {
  germanLexemes,
  germanStem,
  matchesTsQuery,
  toTsVector,
  tsRank,
  websearchToTsQuery,
} from "../../convex/lib/germanFts";
import { compareByRrf, fusedIds, rankBranch, rrfContribution, RRF_K } from "../../convex/lib/rrf";

// ─────────────────────────────────────────────────────────────────────────────
describe("slugify_tag", () => {
  it("transliterates umlauts, exactly as the SQL's nested replace() chain does", () => {
    expect(slugifyTag("Köln")).toBe("koeln");
    expect(slugifyTag("München")).toBe("muenchen");
    expect(slugifyTag("Grüße")).toBe("gruesse");
  });

  it("collapses runs of non-alphanumerics to a single hyphen and trims them", () => {
    expect(slugifyTag("  Bad   Salzuflen! ")).toBe("bad-salzuflen");
    expect(slugifyTag("---Essen---")).toBe("essen");
    expect(slugifyTag("Frankfurt (Oder)")).toBe("frankfurt-oder");
  });

  it("returns '' for input with no alphanumerics — the SQL's `<> ''` guard case", () => {
    expect(slugifyTag("!!!")).toBe("");
    expect(slugifyTag("")).toBe("");
  });

  it("is null-safe (the SQL function is STRICT)", () => {
    expect(slugifyTag(null)).toBe("");
    expect(slugifyTag(undefined)).toBe("");
  });

  it("makes umlaut spelling variants of the same city collide, which is the point", () => {
    // This is what lets `city_centroids()` group "Köln"/"Koeln"/"KÖLN" into one
    // node, and what lets resolve_city_fuzzy match a user typing either.
    expect(slugifyTag("Köln")).toBe(slugifyTag("Koeln"));
    expect(slugifyTag("Köln")).toBe(slugifyTag("KÖLN"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("pg_trgm similarity", () => {
  it("pads each word with two leading and one trailing blank", () => {
    // pg_trgm's generate_trgm: "cat" -> {"  c", " ca", "cat", "at "}
    expect([...trigrams("cat")].sort()).toEqual(["  c", " ca", "at ", "cat"]);
  });

  it("scores an exact match as 1", () => {
    expect(trigramSimilarity("bochum", "bochum")).toBe(1);
  });

  it("scores disjoint strings as 0", () => {
    expect(trigramSimilarity("bochum", "xyz")).toBe(0);
  });

  it("returns 0 rather than null when either side has no trigrams", () => {
    expect(trigramSimilarity("", "bochum")).toBe(0);
    expect(trigramSimilarity("!!!", "bochum")).toBe(0);
  });

  it("ranks a near-miss spelling above an unrelated city", () => {
    // The behaviour resolve_city_fuzzy depends on: a typo still resolves.
    const typo = trigramSimilarity(slugifyTag("Bochm"), slugifyTag("Bochum"));
    const other = trigramSimilarity(slugifyTag("Dortmund"), slugifyTag("Bochum"));
    expect(typo).toBeGreaterThan(other);
  });

  it("clears the RPC's 0.4 floor for umlaut variants of the same city", () => {
    // resolve_city_fuzzy compares SLUGIFIED forms precisely so this works.
    expect(trigramSimilarity(slugifyTag("Koeln"), slugifyTag("Köln"))).toBeGreaterThan(0.4);
  });

  it("is symmetric — it is a Jaccard index over sets", () => {
    expect(trigramSimilarity("bochum", "bochm")).toBe(trigramSimilarity("bochm", "bochum"));
  });

  it("stays below the nm CTE's 0.25 floor for an unrelated studio name", () => {
    expect(trigramSimilarity("Kletterzentrum Neoliet", "yoga")).toBeLessThan(0.25);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("to_tsvector('german', …)", () => {
  it("produces the lexemes CLAUDE.md §10.4 documents for the canonical example", () => {
    // The reference case: `'yoga entspannung anfänger'` stems to
    // `'yoga' & 'entspann' & 'anfang'` in Postgres.
    expect(germanLexemes("Yoga Entspannung Anfänger").sort()).toEqual([
      "anfang",
      "entspann",
      "yoga",
    ]);
  });

  it("applies the Snowball German suffix rules", () => {
    expect(germanStem("entspannung")).toBe("entspann");
    expect(germanStem("anfänger")).toBe("anfang");
    expect(germanStem("kletterkurse")).toBe("kletterkurs");
    expect(germanStem("yoga")).toBe("yoga");
  });

  it("strips umlaut accents in the postlude so ä/ö/ü fold to a/o/u", () => {
    expect(germanStem("anfänger")).not.toMatch(/ä/);
  });

  it("removes German stopwords before stemming", () => {
    // "für", "die", "und" are in the Snowball German stopword list Postgres
    // ships as german.stop.
    const lex = germanLexemes("Krafttraining für die Wiedereinsteiger und Anfänger");
    expect(lex).not.toContain("fur");
    expect(lex).not.toContain("die");
    expect(lex).not.toContain("und");
    expect(lex).toContain("anfang");
  });

  it("dedupes lexemes, as a tsvector's distinct-lexeme set does", () => {
    const lex = germanLexemes("Yoga yoga YOGA");
    expect(lex).toEqual(["yoga"]);
  });

  it("returns [] for null/empty text (the coalesce(...,'') branches)", () => {
    expect(germanLexemes(null)).toEqual([]);
    expect(germanLexemes("")).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("websearch_to_tsquery('german', …) + the @@ operator", () => {
  const doc = toTsVector({
    lexA: germanLexemes("Yogastudio Dortmund"), // name, weight A
    lexB: germanLexemes("Yoga für Anfänger, Hatha, Vinyasa"), // courses_text, weight B
    lexC: germanLexemes("Ein Studio für Entspannung und Rückengesundheit"), // weight C
  });

  it("ANDs bare terms — the behaviour that makes the kw branch rarely fire", () => {
    // CLAUDE.md §10.4: websearch_to_tsquery ANDs terms, so a multi-word German
    // intent must match EVERY stemmed term or the branch contributes nothing.
    // Reproducing the AND is what keeps Convex retrieval comparable rather
    // than accidentally better.
    const q = websearchToTsQuery("yoga entspannung anfänger");
    expect(q).not.toBeNull();
    expect(q!.and).toHaveLength(3);
    expect(matchesTsQuery(doc, q!)).toBe(true);
  });

  it("fails the whole query when a single ANDed term is absent", () => {
    const q = websearchToTsQuery("yoga klettern")!;
    expect(matchesTsQuery(doc, q)).toBe(false);
  });

  it("supports the `or` operator", () => {
    const q = websearchToTsQuery("klettern or yoga")!;
    expect(matchesTsQuery(doc, q)).toBe(true);
  });

  it("supports negation with a leading dash", () => {
    expect(matchesTsQuery(doc, websearchToTsQuery("yoga -klettern")!)).toBe(true);
    expect(matchesTsQuery(doc, websearchToTsQuery("yoga -entspannung")!)).toBe(false);
  });

  it("returns null for empty or stopword-only input", () => {
    expect(websearchToTsQuery("")).toBeNull();
    expect(websearchToTsQuery(null)).toBeNull();
    expect(websearchToTsQuery("und die")).toBeNull();
  });

  it("ts_rank weights a name hit (A) above a body hit (C)", () => {
    // ts_rank's default weight vector is {D,C,B,A} = {0.1, 0.2, 0.4, 1.0}.
    // Only the resulting ORDER feeds RRF — see the fidelity note in
    // convex/lib/germanFts.ts.
    const nameHit = tsRank(doc, websearchToTsQuery("yogastudio")!);
    const bodyHit = tsRank(doc, websearchToTsQuery("rückengesundheit")!);
    expect(nameHit).toBeGreaterThan(bodyHit);
  });

  it("ts_rank stays in (0, 1) and is 0 for a non-match", () => {
    const hit = tsRank(doc, websearchToTsQuery("yoga")!);
    expect(hit).toBeGreaterThan(0);
    expect(hit).toBeLessThan(1);
    expect(tsRank(doc, websearchToTsQuery("klettern")!)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("match_partners RRF fusion", () => {
  it("assigns 1-based ranks by score desc, like row_number() over (order by … desc)", () => {
    const ranked = rankBranch([
      { sourceId: 7, score: 0.1 },
      { sourceId: 3, score: 0.9 },
      { sourceId: 5, score: 0.5 },
    ]);
    expect(ranked.get(3)!.rnk).toBe(1);
    expect(ranked.get(5)!.rnk).toBe(2);
    expect(ranked.get(7)!.rnk).toBe(3);
  });

  it("breaks score ties by partner id ascending (determinism, CLAUDE.md §12.7)", () => {
    const ranked = rankBranch([
      { sourceId: 9, score: 0.5 },
      { sourceId: 2, score: 0.5 },
    ]);
    expect(ranked.get(2)!.rnk).toBe(1);
    expect(ranked.get(9)!.rnk).toBe(2);
  });

  it("caps each branch at its limit — the SQL's `limit 40` per CTE", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ sourceId: i, score: 100 - i }));
    expect(rankBranch(many, 40).size).toBe(40);
  });

  it("computes 1/(60 + rnk) per branch and 0 for an absent one (coalesce)", () => {
    expect(rrfContribution({ rnk: 1, score: 0 })).toBeCloseTo(1 / (RRF_K + 1), 12);
    expect(rrfContribution(undefined)).toBe(0);
  });

  it("full-outer-joins the branches: an id in ANY branch survives", () => {
    const vec = rankBranch([{ sourceId: 1, score: 0.9 }]);
    const kw = rankBranch([{ sourceId: 2, score: 0.4 }]);
    const tg = rankBranch([{ sourceId: 3, score: 2 }]);
    expect(fusedIds([vec, kw, tg]).sort()).toEqual([1, 2, 3]);
  });

  it("ranks a partner matched by several branches above one matched by a single branch", () => {
    // The whole point of RRF: agreement across independent signals beats a
    // strong score in one signal.
    const vec = rankBranch([
      { sourceId: 1, score: 0.95 }, // rank 1 in vec only
      { sourceId: 2, score: 0.5 }, // rank 2 in vec …
    ]);
    const kw = rankBranch([{ sourceId: 2, score: 0.8 }]); // … but rank 1 in kw
    const tg = rankBranch([{ sourceId: 2, score: 3 }]); // … and rank 1 in tg

    const scored = fusedIds([vec, kw, tg]).map((sourceId) => ({
      sourceId,
      rrf_score:
        rrfContribution(vec.get(sourceId)) +
        rrfContribution(kw.get(sourceId)) +
        rrfContribution(tg.get(sourceId)),
    }));

    expect([...scored].sort(compareByRrf).map((r) => r.sourceId)).toEqual([2, 1]);
  });

  it("orders a full tie by partner id ascending (`order by rrf_score desc, g.id`)", () => {
    const rows = [
      { sourceId: 9, rrf_score: 0.5 },
      { sourceId: 4, rrf_score: 0.5 },
    ];
    expect([...rows].sort(compareByRrf).map((r) => r.sourceId)).toEqual([4, 9]);
  });
});
