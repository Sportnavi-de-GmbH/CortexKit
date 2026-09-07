# Partner logo cards in the Navio widget — design

**Date:** 2026-09-07
**Status:** approved, not implemented
**Surface:** Navio widget, Partner-Finder screen (`screen === "partner"`)

---

## 1. Problem

A partner search answer reaches the visitor as **free-form German markdown prose**
written by the model, rendered by a generic `Markdown` component into a grey chat
bubble (`components/navio/NavioWidget.tsx`, the `BotBubble` branch). It is
information-dense, uniform, and hard to scan: five studios, each with contact
details, as one wall of text.

Every active partner has a usable image. `public.partners.logo_url` is populated for
**2,326 of 2,331** active partners (S3 URLs, transparent PNGs). That column is
referenced **nowhere in the codebase** — not in `PartnerLite`, not in `llm_profile`,
not in the Convex schema — and it never reaches the browser.

The goal is a visibly more premium, scannable presentation of **the same answer**,
using that image.

## 2. Goals

- Show each recommended partner as a card led by its logo.
- Leave the model's response text, the prompt, the model, and the API contract
  **completely unchanged**.
- Keep the change additive and trivially reversible.

## 3. Non-goals

- No change to retrieval, ranking, gap-fill, or any partner-selection logic.
- No change to `agent/instructions.md`.
- No detail overlay / modal, no carousel. Inline cards only.
- No condensing, folding or hiding of the prose (explicitly rejected — see §4).
- **No contact details on the cards.** Email and phone reach the model through
  exactly one path (the pre-rendered `llm_profile`) and reach the visitor through
  exactly one surface (the prose). A card repeating them would create a second shape
  of the same fact — the failure mode root `CLAUDE.md` §12.4 exists to prevent.

## 4. Decisions taken

| Question | Decision | Rationale |
|---|---|---|
| Which surface? | The visitor-facing Partner-Finder chat screen | What real users on sportnavi.de see |
| Interaction model? | Inline cards in the chat | Lowest risk; reads as part of the conversation |
| Cards vs. prose? | Cards **below**, prose fully intact | Strictly additive; nothing model-written is hidden or reworded |
| Which build? | A **new sibling**, `partner-recommendation-agent-supabase-with-logo` | Avoids a Convex migration and the diff-clean rule (§6) |

Accepted cost of "prose fully intact": each partner appears twice — once in the
paragraph, once in a card. This was chosen deliberately over folding the prose,
because folding depends on model-written markdown having a predictable structure,
which is not guaranteed.

## 5. Architecture

No new protocol. The design reads a channel the widget currently ignores.

```
find_partners.execute()          already knows the exact shortlist + partner ids
  returns FindPartnersResult
    + NEW  cards: PartnerCard[]
        |
        v
eve emits  action.result { kind: "tool-result", toolName, output }
        |            protocol/message.d.ts:196
        |            runtime/actions/types.d.ts:107  (output is JsonValue)
        v
/api/partner proxy               relays the SSE stream verbatim; no change needed
        |
        v
widget stream -> collect cards keyed by turnId
        |
        v
<PartnerCards/>  rendered after <BotBubble>, before <FeedbackControls>
```

`toModelOutput` keeps returning `renderedText` unchanged, so **the model never sees
the `cards` field**: no added tokens, no prompt-cache prefix change, and no second
shape of a fact the model reasons over.

### PartnerCard shape

```ts
interface PartnerCard {
  partnerId: number;
  name: string;
  city: string | null;
  tags: string[];
  websiteUrl: string | null;
  logoUrl: string | null;
  source: "home" | "nearby";
  sourceCity: string;
  distanceKm?: number;
}
```

All fields except `logoUrl` already exist on the shortlist inside `find_partners`
(`resolution.allFound[]` and the `built` shortlist).

## 6. Why a new sibling build

The production partner agent is the **Convex** build, whose `partners` table has
`websiteUrl` but no `logoUrl` — adding logos there means a schema field plus a
reseed. Its `CLAUDE.md` §1 additionally requires `agent/` to stay diff-clean against
the Supabase build, with business-logic changes landing in both builds in the same
commit; editing `find_partners.ts` would trigger that rule.

The Supabase build queries `public.partners` directly, where `logo_url` already
lives. Branching a new sibling from `partner-recommendation-agent-supabase` (the R13
port — 131 tracked files, complete and runnable) therefore needs **no migration, no
reseed, and no diff-clean exception**, and leaves every existing build untouched.

## 7. Change set

| Where | Change |
|---|---|
| `SportnaviPartnerRecomandationBot/partner-recommendation-agent-supabase-with-logo/` | New folder, copied from `…-supabase`. Deps via `npm ci` against the committed lockfile |
| `lib/supabase.ts` | Add one `getPartnerLogos(ids)` backend method. `PARTNER_SELECT_COLUMNS` is **not** widened — see below |
| `lib/partners/build-recommendations.ts` | Carry `logoUrl` onto the shortlist entries |
| `agent/tools/find_partners.ts` | Attach `cards[]` to the `execute()` return value only |
| `kb-agent-langsmith-starter/components/navio/PartnerCards.tsx` | New component |
| `kb-agent-langsmith-starter/components/navio/NavioWidget.tsx` | Subscribe to `action.result`; render `<PartnerCards/>` on the partner surface only |
| `kb-agent-langsmith-starter/.env.local` | `PARTNER_AGENT_HOST` -> `http://127.0.0.1:3007` |

Ports in use locally: widget 3001, Docker `sportnavi-web-local` 3002, orchestrator
3003, Convex partner agent 3005, Supabase R13 build 3006. The new build takes 3007.

### Logos take exactly ONE path

`logo_url` is fetched **only** by `getPartnerLogos(shortlistIds)`, keyed on the final
shortlist. It is deliberately not added to `PARTNER_SELECT_COLUMNS`.

Two reasons. First, correctness: `PARTNER_SELECT_COLUMNS` feeds `getPartnersByCity`,
which serves **home** partners only — gap-filled partners arrive through the
`match_partners` RPC, which returns no `logo_url`. Sourcing logos there would give
home studios a logo and borrowed studios a monogram, making the fallback look like a
data gap when it is really a code path gap. Second, cost: the home projection is read
for every candidate in the city, while only five partners are ever shown.

One lookup, keyed on the ids actually rendered, covers home and nearby identically.

### The get_partner_profiles RPC is deliberately NOT modified

The shortlist profiles come from the `get_partner_profiles` Postgres RPC. Adding a
column there requires a `DROP`/`CREATE` migration on the **shared** Supabase project,
which the retired Supabase build and the Convex seed path also call.

Instead: a separate `select("id, logo_url").in("id", shortlistIds)` lookup — five
ids, primary-key indexed, final shortlist only. No migration, no blast radius on
other builds. This follows the smallest-safe-change rule (root `CLAUDE.md` §14).

## 8. Card visual specification

Follows `docs/design/WIDGET-DESIGN-GUIDELINES.md`. The palette stays two-colour:
`--brand-green` is the only accent, and `--brand-orange` remains reserved for human
hand-off and **must not appear** on these cards.

- **Logo** — 52px `object-contain` tile, `rounded-xl`, on a white plate with a
  hairline border. The plate is required: the S3 assets are transparent PNGs and
  would disappear against the dark theme.
- **Name** — `font-headline`, semibold, 15px.
- **City line** — 12px `--fg-muted`.
- **Tags** — up to 3 muted pills; overflow dropped, never truncated mid-word.
- **Website** — the existing green-underline `a` treatment from `Markdown`, so the
  card reads as the same design system rather than a bolt-on.
- **Missing logo** (5 partners) — monogram tile: `--accent-dim` ground, the studio
  initials in `--fg`. Never a broken image, never an empty box.
- **Layout** — vertical stack, full width of the bubble column (`max-w-[560px]`),
  8px gaps. Cards wrap naturally on narrow iframes; no horizontal scrolling anywhere.

### Gap-fill disclosure is mandatory on the card

When `source === "nearby"`, the card **must** show the borrowed city and distance
(e.g. `Herne · 12 km`). Navio's product invariant is that borrowing is always
disclosed. A card that rendered a borrowed studio as though it were local would break
in the UI exactly what the prompt protects in the text. This is a correctness
requirement, not a styling preference.

## 9. Failure and degradation

Every path degrades to today's behaviour — prose in a bubble.

| Condition | Behaviour |
|---|---|
| No `action.result` for `find_partners` (greeting, clarification turn) | No cards; unchanged UI |
| `cards` absent or malformed | No cards. Never throw; never blank the answer |
| `logoUrl` null | Monogram fallback tile |
| Logo URL 404s / S3 unreachable | `onError` swaps to the monogram tile |
| Tool ran but returned zero partners | No cards; the prose already explains |
| FAQ surface (`screen === "chat"`) | Cards never render — partner surface only |

The widget must treat card data as untrusted display data: no HTML injection,
`logoUrl` rendered only as an `<img src>`, `websiteUrl` only as an `href` with
`rel="noreferrer"`, matching the existing link treatment.

## 10. Verification

**Step 1, before anything else is built — prove the transport assumption.**
The entire design rests on `action.result.output` carrying the tool's **raw return
value** rather than `toModelOutput`'s rendered text. Run both services, perform one
real "Yoga in Bochum" search, and log the `action.result` payload in the browser.

If it carries the rendered text instead, the remedy is small (emit the cards through
a different part type) but the plan changes — so this is proven before the column
change, not after.

**Then:**

- Unit: card normalisation from a tool result; null-logo fallback; a malformed
  payload yields no cards and no throw.
- Unit: a `nearby` card always carries its source city.
- Live: one real search on the Partner-Finder screen showing five cards with logos.
- Regression: the prose is byte-identical to the pre-change response for the same
  query; the FAQ screen renders no cards.

## 11. Risks

| Risk | Mitigation |
|---|---|
| `output` is the rendered text, not the raw return | Verified first (§10) before any other work |
| Duplicated information makes the bubble long | Accepted deliberately (§4); reversible |
| Logo assets are third-party S3 URLs | `/widget` sets only `frame-ancestors`, no `img-src` — verified in `next.config.mjs`, so no CSP block |
| A new build drifts from its parent | It is a deliberate fork for one feature; parity is not a goal here |
| Another unpushed build increases local-only work | Pre-existing: commit `0759065` is already local-only pending repo write access |

## 12. Rollback

Point `PARTNER_AGENT_HOST` back at the previous agent and remove the
`<PartnerCards/>` render. The prose path is untouched throughout, so rollback cannot
affect answer content.
