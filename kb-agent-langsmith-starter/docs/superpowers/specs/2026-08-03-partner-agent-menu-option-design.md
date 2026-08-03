# Design — Partner agent as a Navio menu option

**Date:** 2026-08-03
**Status:** Approved (brainstorming) — ready for implementation planning
**Scope:** Add the Sportnavi Partner Recommendation agent as a third option in the
Navio Plus menu, working end-to-end in the **dev console** first. Production hosting
and security are an explicit follow-up.

---

## 1. Context

The CortexKit workspace hosts two independent eve agent projects (see root
`CLAUDE.md` §1/§1A):

- **Project 1 — `kb-agent-langsmith-starter/`** — the KB/FAQ Navio chatbot. Owns the
  embeddable widget (`components/navio/`, `app/widget/page.tsx`) and the "Navio Plus"
  menu (greeting → consent → menu → {chat | contact | info}).
- **Project 2 — `SportnaviPartnerRecomandationBot/partner-recommendation-agent`** —
  package `eve-partner-agent`, a tool-calling RAG partner finder (Supabase + embeddings,
  two live tools). **A separate git repo with its own deploy.** It has **no custom eve
  channel**, so it accepts loopback/dev traffic with eve's defaults.

**Goal:** let a user pick "Partner finden" in the KB widget's menu and chat with the
partner agent alongside the existing FAQ chat and contact form.

**Chosen approach (from brainstorming):**
- **Hosting model:** the partner agent stays its own service; the KB app reaches it
  through a **same-origin proxy** (`/api/partner/*`). Lowest coupling — repos stay
  separate — while the browser stays same-origin (reusing consent, BotID, no CORS).
- **Scope:** a **working dev-console demo first**; productionize hosting/security later.

### Key framework facts (verified against `node_modules/eve`)
- `useEveAgent({ host })` points a client at a base URL — a same-origin prefix like
  `/api/partner` (our proxy) or an absolute origin. It is **lazy**: no session/network
  until the first `send()`.
- The widget is a screen-state machine in `components/navio/NavioWidget.tsx`; the menu is
  `components/navio/NavioMenu.tsx`; the FAQ agent is created in `app/widget/page.tsx` via
  `useEveAgent()` and passed in as a prop.
- Palette (`app/globals.css`) is deliberately two-color: `--brand-green` = the single
  call-to-action / AI-chat color, `--brand-orange` = human-handoff attention. **No new
  brand color is introduced.**

---

## 2. Target flow

```
greeting → consent → menu ─┬─ "FAQ-Agent"       → chat    (existing; KB agent, same-origin /eve/v1/*)
                           ├─ "Partner finden"  → partner (NEW; partner agent via /api/partner/*)
                           └─ "Kontaktformular" → contact (existing)
```

One consent gate covers all three options (unchanged). Header/back-nav/reset behave for
`partner` exactly as they do for `chat`.

---

## 3. Units of work

### Unit A — Partner proxy (new)

**File:** `app/api/partner/[...path]/route.ts` (KB app, Next.js App Router, `runtime = "nodejs"`).

- **Purpose:** same-origin passthrough from the browser to the partner eve host.
- **Behavior:** forwards `GET`/`POST` on `/api/partner/<path>` to
  `${PARTNER_AGENT_HOST}/<path>`, returning the upstream `Response` with its body stream
  intact (`export const dynamic = "force-dynamic"`; no caching) so eve's `text/event-stream`
  responses stream through unbuffered.
- **Depends on:** `PARTNER_AGENT_HOST` (env). When unset → respond `503` (feature off),
  so the KB widget keeps working with no partner host configured.
- **Guards:**
  - Only forward when the joined `path` begins with `eve/` — this is not an open proxy
    (prevents SSRF to arbitrary upstream paths).
  - Strip hop-by-hop / host headers before forwarding (`host`, `connection`,
    `content-length` recomputed by fetch); forward cookies and content-type.
  - POST body forwarded as-is (small JSON; no request-body streaming needed).
- **Interface consumed by:** the partner `useEveAgent({ host: "/api/partner" })` client.

> Considered alternative: a `next.config` `rewrites()` entry. Rejected for the primary
> path because a route handler gives an explicit SSRF guard, the 503-when-off behavior,
> and unit-testability. (A rewrite remains a valid lighter option if the handler proves
> unnecessary.)

### Unit B — Dual-agent wiring

**File:** `app/widget/page.tsx`.

- Create a second connection next to the existing FAQ agent and pass both down:
  ```ts
  const faqAgent     = useEveAgent();                         // KB agent, same-origin
  const partnerAgent = useEveAgent({ host: "/api/partner" }); // partner agent, proxied
  return <NavioWidget faqAgent={faqAgent} partnerAgent={partnerAgent} />;
  ```
- Both are lazy, so mounting the partner agent costs nothing until the user opens the
  partner screen and sends. History is preserved across menu ↔ partner navigation.

### Unit C — Menu card + partner screen

**Files:** `components/navio/NavioMenu.tsx`, `components/navio/NavioWidget.tsx`.

- **Menu:** add a third `OptionCard` — **"Partner finden"**, subtitle
  *"Finde Studios & Kurse in deiner Nähe."*, **green accent, `MapPin` icon** →
  `onSelectPartner`. (Green = both AI-chat options; orange stays the contact/handoff card.)
  `NavioMenu` gains an `onSelectPartner` prop.
- **Widget:** add `"partner"` to the `Screen` union and the `HEADER` map (title e.g.
  *"Partner-Finder"*, subtitle "Online", dot true); render the chat body bound to
  `partnerAgent`; include `partner` in `showBack`, the reset button, and the input bar.
- **Small refactor (no FAQ behavior change):** `ChatBody`/`InputBar` currently hard-code the
  FAQ greeting, `QUICK_REPLIES`, and placeholder. Extract these into a small per-agent
  config object (e.g. `{ agent, greetingDe, greetingEn, quickReplies, placeholder }`) so
  both the FAQ and partner screens reuse the same components with different copy.
  - Partner greeting (DE): *"Sag mir, wo und was du trainieren willst — z. B. 'Yoga in
    Bochum' 📍"*; EN mirror.
  - Partner quick-replies: city/activity examples, e.g. *"Yoga in Bochum"*,
    *"Klettern für Anfänger"*, *"Fitnessstudio in Bielefeld"*, *"Reha-Sport"*.
- `NavioWidget`'s props change from `{ agent }` to `{ faqAgent, partnerAgent }`.

### Unit D — Config & dev runbook

- `.env.example` (+ local `.env.local`): add `PARTNER_AGENT_HOST` with a documented default
  of `http://localhost:3001` and a note that unset = partner option disabled (proxy 503).
- **Runbook (README / docs):**
  1. Start **project 2** on its own port with its own `.env.local` (Azure + Supabase +
     embeddings): `npm run dev:ui -- -p 3001` (its Next console proxies `/eve/v1/*` to its
     eve backend).
  2. Start **project 1** with `PARTNER_AGENT_HOST=http://localhost:3001`: `npm run dev:ui`.
  3. Open the KB widget → **Partner finden** → chat (e.g. "Yoga in Bochum").

---

## 4. Testing

- **Unit:** `app/api/partner` proxy — with a mocked `fetch`: (a) `PARTNER_AGENT_HOST`
  unset → 503; (b) non-`eve/` path → rejected; (c) allowed path forwards method + body and
  returns upstream status/body. (Vitest, consistent with existing `tests/`.)
- **Type/build:** `npm run typecheck` must pass (notably the `NavioWidget` prop change and
  the new `Screen` variant).
- **Manual:** dev-console click-through — menu shows three cards; partner chat streams a
  real answer via the proxy; back/reset work; FAQ + contact unchanged.

---

## 5. Out of scope (productionization follow-up)

Deferred by the "demo first" decision, and the proxy is written so production is mostly a
`PARTNER_AGENT_HOST` swap:

- Real hosting/deploy of the partner service and the proxy target URL.
- A custom eve **channel/auth** on the partner service (origin allowlist + BotID +
  rate-limit), mirroring project 1's `agent/channels/eve.ts`.
- Cross-origin cookie/visitor-id strategy if the partner service is deployed on a
  different origin behind the proxy.
- Consent-scope confirmation, per-turn telemetry/observability for partner turns, and
  any menu copy/legal review.
- Session-budget / input-size hardening on the partner path (project 2 already sets
  `limits`; revisit once traffic flows through the proxy).

---

## 6. Files touched (summary)

| File | Change |
|---|---|
| `app/api/partner/[...path]/route.ts` | **new** — same-origin proxy to the partner eve host |
| `app/widget/page.tsx` | create `partnerAgent`; pass `{ faqAgent, partnerAgent }` |
| `components/navio/NavioWidget.tsx` | `partner` screen + header; prop change; parametrized chat body |
| `components/navio/NavioMenu.tsx` | third `OptionCard` + `onSelectPartner` prop |
| `.env.example` | add `PARTNER_AGENT_HOST` |
| `README.md` / docs | dev runbook for two-service local demo |
| `tests/` | proxy unit test |
