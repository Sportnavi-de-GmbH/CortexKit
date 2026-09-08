# Navio Orchestrator — menu restructure design (2026-09-08)

## Goal

Give the multi-agent orchestrator (service 3) the same Navio Plus menu design and
navigation as the reference widget in `kb-agent-langsmith-starter`, while keeping the
Master → FAQ-subagent / Partner-tool agent architecture and all existing business
logic intact.

## Reference resolution

The request named two references:

- `SportnaviPartnerRecomandationBot/partner-recommendation-agent-supabase` — has **no
  widget/menu UI at all** (it is the partner agent + a dev dashboard). It is treated as
  the reference for the **Partner Agent behavior** the orchestrator's `find_partners`
  tool targets (`PARTNER_AGENT_HOST`, port 3006 locally).
- `kb-agent-langsmith-starter` — carries the actual Navio Plus menu
  (`components/navio/NavioMenu.tsx` + shell in `NavioWidget.tsx`, including the current
  uncommitted design pass: single white header with the Sportnavi logo lockup, priority
  grid menu, site-link chips, NavioLogo greeting). **This is the design source of truth.**

## Agents (unchanged)

Master (router, `agent/agent.ts`) → `faq` local subagent · `find_partners` HTTP tool →
partner agent · `request_human_contact` (approval-gated) · `provide_booking_link`.
No agent code changes.

## Widget changes (`components/navio/NavioWidget.tsx` + `app/widget/page.tsx`)

- Screens become `greeting | consent | menu | chat | partner | contact | info`
  (menu restored; consent → menu, back arrows → menu).
- Ported verbatim from the reference: `NavioMenu.tsx`, `links.ts`, `SportnaviLogo.tsx`,
  `NavioLogo.tsx`, `public/sportnavi-logo.svg`, `public/navio-logo.svg`; header /
  greeting / consent / footer / intro-composition / quick-reply / input-bar styling.
- Menu contents (exactly the reference layout):
  - Green primary rows: **FAQ-Agent** → `chat`, **Partner finden** → `partner`.
  - Orange secondary tiles: **Kontaktformular** → `contact`, **Termin buchen** → opens
    `NEXT_PUBLIC_BOOKING_URL` in a new tab (tile hidden when unset).
  - Always-visible site-link chips ("Mehr auf sportnavi.de"): FAQ / Hilfe · Studios ·
    Kontakt · Über uns · Datenschutz.
- **Both chat screens talk to the master agent.** `app/widget/page.tsx` mounts two
  `useEveAgent()` clients (same origin, `maxReconnectAttempts: 12`), so the FAQ-Agent
  and Partner-Finder screens are independent conversations — same behavior as the
  reference — while the master still owns routing inside each. A partner question typed
  on the FAQ screen still works; the screens only differ in greeting, quick replies and
  placeholder.
- Kept from the orchestrator (business logic, untouched): `ApprovalPrompt` (parked
  `ask_question` / approval turns), agent-driven contact-form escalation (now armed on
  both chat screens, handled per screen), typing dots while streaming-with-no-text,
  `FeedbackControls` (no `surface` — the server resolves the route), `KontaktForm`.
- **Not ported:** `MessageActions` / `DataNotice` / `lib/message-limits` — they depend on
  service 1's prompt `[[action:…]]` markers and its server-side 300-char cap. Porting
  them would require prompt/channel changes, i.e. business-logic changes out of scope.

## Config

- `.env.example`: add `NEXT_PUBLIC_BOOKING_URL` (menu tile), point the
  `PARTNER_AGENT_HOST` guidance at the Supabase R13 build (port 3006) with the Convex
  build (3005) noted as the alternative.
- `app/globals.css`: sync the reference's current tokens (ink user bubble, amber
  `--warn-*` set) so the ported components render identically.

## Testing

`npm run typecheck` + `npm run agent:info` + `npm test` must stay green; no test
covers the widget UI, so verification of the menu is visual (dev run).
