# Navio Orchestrator — chat-first redesign (2026-09-08)

**Supersedes** `2026-09-08-menu-restructure-design.md` (the menu-first flow, same day).
The owner reversed direction: the widget must open **directly into one chat**; the
Master Agent is the entry point and routes every message. No agent-selection menu.

## What changed

- **Screens**: `greeting → consent → chat` (+ `contact`, `info` sub-screens, back → chat).
  The `menu` and `partner` screens are gone; `NavioMenu.tsx` deleted. One `useEveAgent`
  client again — one session, one history, which is what lets follow-ups switch intent
  (FAQ → partner → FAQ) naturally.
- **FAQ subagent runs the NEW prompt**: `agent/subagents/faq/instructions.md` is now a
  verbatim copy of `kb-agent-langsmith-starter/agent/instructions.md` (86 KB, the active
  copy of `agent/prompts/instructions-v2.md`). Known accepted mismatch: its §6 prose
  still describes the kb widget's menu/Partner-Finder screen; harmless here because the
  master routes partner questions to `find_partners` directly. Revise on the next prompt
  pass, do not hand-edit the copy.
- **Quick-action chips during conversation** (the §7 requirement): both specialist
  prompts end answers with `[[action:…]]` / `[[notice:data]]` marker lines; the master
  relays them verbatim — **R7 gained one sentence** making the marker line explicitly part
  of the verbatim answer (relay exactly, never mention). The UI side is ported from
  kb-agent: `lib/navio-actions.ts` (parse/strip + guaranteed chips), 
  `components/navio/MessageActions.tsx`, `components/navio/DataNotice.tsx`,
  `tests/navio-actions.test.ts`.
- **Chip targets in this single-chat widget** (owner decisions 2026-09-08):
  `partner` → external link to sportnavi.de/studios ("Partner finden") ·
  `studios` → same URL ("Studios durchsuchen") · `contact` → contact screen (the only
  in-widget navigation; disabled while a turn is parked on `input.requested`, so the
  ApprovalPrompt can't be stranded) · `meeting` → `NEXT_PUBLIC_BOOKING_URL` new tab
  (chip dropped when unset) · `faq`/`about` → external links · `faq-agent` (partner
  prompt) → stripped from text, **no chip** (no FAQ screen exists to switch to).
- **Guaranteed chips** (owner requirement, follow-up 2026-09-08): EVERY answer carries
  `contact` + `meeting` + `about` — the visitor can always reach the Sportnavi team —
  under a fixed lead-in line ("Du möchtest das Sportnavi-Team erreichen …?"), rendered
  by the UI so it holds even when the model forgets. An answer whose turn actually ran
  `find_partners` additionally guarantees `studios` ("Studios durchsuchen"), detected
  from the `action.result` event's `turnId` matched to the message's `metadata.turnId` —
  NOT from markers, which the R7 relay can drop (observed live: markers dropped, chip
  still rendered).
- **Rendering contract**: markers stripped on every render (partial-marker swallow
  prevents streaming flicker); typing dots computed on the PARSED text; a marker-only
  relay renders its chip row without an empty bubble; notice + chips + feedback thumbs
  only at `status === "complete"`.

- **Message cap** (follow-up 2026-09-08): the reference widget's 300-char limit is ported
  1:1 — `lib/message-limits.ts` (one constant, `NEXT_PUBLIC_NAVIO_MAX_MESSAGE_CHARS`)
  drives the composer counter/warning in `NavioWidget.tsx` AND the API gate
  `messageLengthLimit()` in `agent/channels/eve.ts`, so the UI never promises what the
  server would reject. No hard `maxlength`: an over-long paste keeps the text, disables
  send, and names the exact overflow ("Kürze um N Zeichen — oder schick es in zwei
  Nachrichten"). Verified live: 403 + friendly detail at 301+, session created at 300.

- **Latency / TTFT pass** (follow-up 2026-09-08, PM): three additive client-side
  mechanisms, zero agent changes:
  1. **UI-guaranteed announcement** — gpt-4o delegates silently on ~half of turns no
     matter the prompt wording (measured), so `NavioWidget` renders the R2 announcement
     itself when the delegation appears on the wire (`currentTurnDelegationFrom`,
     lib/specialist-preview.ts). First visible feedback is now deterministic ~3s.
  2. **Early-answer preview** — `useSpecialistPreview` attaches to the FAQ child
     session's own stream (`subagent.called` → `GET /eve/v1/session/:childId/stream`,
     replayed from index 0) and lifts finished `find_partners` answers out of
     `action.result`, so specialist content renders BEFORE the master finishes
     re-typing it (measured: child text streams at ~5s vs turn end ~12s). The relayed
     message stays authoritative (chips, feedback, history); the preview yields when
     the relay's text arrives (visible-answer-count baseline, NOT the `waiting` flag —
     that closes at the announcement, which was the first implementation's bug).
  3. **Same-step parallel dispatch** (R6) — verified: faq + 2× find_partners in one
     step, triple-intent turn 23.5s total.
  verify-e2e tracks model-side R2 compliance as WARNINGS (the UI covers the visitor);
  the speak-without-call stall stays a FAILURE.

## Deliberately unchanged

Master routing rules (R1–R9 cover FAQ/partner/mixed/ambiguous/follow-up/escalation
cases), the partner agent (supabase build via `PARTNER_AGENT_HOST=…:3006`), feedback,
Langfuse wiring, channel security.

## Recorded risk — RESOLVED same day

The gpt-4o-mini router risk materialized in a live transcript (stall, wrong language,
internal leak, broken slot-filling). Resolved 2026-09-08 (owner decision): router AND
FAQ subagent upgraded to **gpt-4o** (`navio-chatbot` resource), plus surgical routing-
prompt revisions and a transcript-derived multi-turn regression suite in
`scripts/verify-e2e.ts` — measured **9/9 on two consecutive runs**, with parallel
same-step dispatch cutting a triple-intent turn to 23.5s. Details: CLAUDE.md §2.4c.
