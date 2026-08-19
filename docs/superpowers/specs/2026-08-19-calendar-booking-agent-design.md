# Calendar Booking capability for navio-orchestrator — Design

**Status:** approved, ready for planning.
**Date:** 2026-08-19.
**Scope:** `navio-orchestrator/` (service 3) only. Does not touch service 1
(`kb-agent-langsmith-starter`) or service 2 (`SportnaviPartnerRecomandationBot`) — see
workspace `CLAUDE.md` §14 scope-safety rule.
**Supersedes:** the "4. Booking agent" phase in
[`docs/NAVIO-MULTI-AGENT-ARCHITECTURE.md`](../../NAVIO-MULTI-AGENT-ARCHITECTURE.md) §4.4/§11,
which planned a local `subagents/booking/` with a Microsoft Graph connection and an
`approval: always()`-gated `book_meeting` write tool. That plan is **not being built**. This
document replaces it for the booking capability; the rest of that architecture doc (master
router, FAQ subagent, `find_partners`, `request_human_contact`) is unchanged.

---

## 1. What changed from the original phase-4 plan, and why

The original plan assumed the booking agent would read real calendar free/busy via Microsoft
Graph and eventually write a meeting. The actual requirement is narrower and was confirmed in
discussion:

- **Read-only, permanently.** The agent must never create or modify a calendar event.
- **No real availability read at all.** There is one static, pre-configured booking URL (a
  Calendly-style self-service page). The agent's only job is recognizing booking intent and
  handing that URL back to the visitor, who completes the booking on the external platform.
- **Communication is tools-only**, consistent with how the rest of the master already works —
  agents/capabilities never talk to each other directly; everything is a tool call the router
  makes and a result it relays.

Because there is no real data to read and no write path at all, this eliminates the entire
reason the original plan needed a subagent and a Microsoft Graph connection: there is no prompt
of its own, no multi-turn logic, and no external system to authenticate against. `@vercel/connect`
and the Microsoft Graph dependency are dropped from the roadmap.

---

## 2. Where it lives

A third tool on the master, at the same tier as `find_partners` and `request_human_contact` —
**not** a subagent:

```
agent/tools/
├── find_partners.ts
├── request_human_contact.ts     approval: always()
└── provide_booking_link.ts      ★ NEW — no approval, no side effects
```

**Why a tool, not a subagent** (the trade-off this design was specifically asked to resolve, by
reading `request_human_contact.ts` and `agent/instructions.md`):

- `request_human_contact` carries `approval: always()` because it gates something
  consequential — a UI transition into a form that collects PII behind two legally-binding
  consent checkboxes (Datenschutz, Widerrufsbelehrung) that only a human may tick. The approval
  pause is a *runtime-enforced human-in-the-loop gate* protecting that specific irreversible,
  legally-sensitive action.
- The booking tool has none of that. Navio collects no PII, presents no consent checkbox, and
  nothing happens inside Navio at all — the visitor leaves the chat entirely to finish booking
  on the external platform. It is closer in kind to `find_partners`/`faq`: a plain information
  tool that returns data (a URL string) for the master to relay verbatim under rule R7.
- A subagent would only add relay latency (the architecture doc's own R1 risk — a child's
  answer returns as a tool result and must be re-emitted by the master, roughly doubling output
  tokens for that turn) for something that is a single static string with no logic of its own.
  Not justified here.

---

## 3. Tool interface

```ts
// agent/tools/provide_booking_link.ts
export default defineTool({
  description:
    "Gibt den Buchungslink zur Terminvereinbarung mit dem Sportnavi-Team zurück " +
    "(z. B. für eine Produktdemo oder ein Beratungsgespräch). Nutze das NUR bei " +
    "explizitem Terminwunsch (\"Termin\", \"Demo\", \"Beratungsgespräch\", \"Zeit " +
    "vereinbaren\"). NICHT für Support, Rechnungen, Kündigungen oder allgemeine " +
    "Fragen — dafür ist request_human_contact zuständig.",
  inputSchema: z.object({}),   // no input needed — one static URL, no disambiguation
  // No approval gate — read-only, no PII, no consequential action inside Navio.
  async execute() {
    const url = process.env.BOOKING_URL?.trim();
    if (!url) {
      // Config gap, not a visitor error — fail closed, let the master fall
      // back honestly instead of inventing a link.
      return { available: false };
    }
    return { available: true, bookingUrl: url };
  },
});
```

- `inputSchema: z.object({})` is deliberately empty — there is nothing to disambiguate, so the
  model is not given parameters to invent.
- Output is `{ available, bookingUrl? }`, not a bare string, so the prompt has an explicit
  branch for "not configured" rather than relaying `undefined`.
- Missing `BOOKING_URL` degrades the same way `PARTNER_AGENT_HOST` unset does elsewhere in
  Navio (workspace `CLAUDE.md` §6): the capability quietly becomes unavailable, nothing throws,
  the rest of the widget is unaffected.

---

## 4. Prompt / routing changes — `agent/instructions.md`

**New 4th entry under "WAS DU KANNST"**, matching the existing capability-map pattern (positive
examples + an explicit NICHT clause):

```
**4. `provide_booking_link` — einen Termin vereinbaren**

Nutze das für: einen expliziten Terminwunsch (Demo, Beratungsgespräch, „Termin
vereinbaren"). Gibt einen Buchungslink zurück, den die Nutzerin selbst öffnet.

Beispiele: „Kann ich eine Demo buchen?" · „Ich hätte gern einen Termin mit euch" ·
„Wie kann ich ein Beratungsgespräch vereinbaren?"

NICHT für: Support, Rechnungen, Kündigungen, Beschwerden oder „ich will mit
jemandem sprechen" ohne Terminbezug — dafür ist `request_human_contact` zuständig.
```

**New disambiguation row**, extending the existing "Frage → Richtig" table:

| Frage | Richtig |
|---|---|
| „Ich will mit jemandem sprechen" (kein Terminbezug) | `request_human_contact` |
| „Kann ich einen Termin vereinbaren?" | `provide_booking_link` |

**Routing split (decided):** booking intent must be **explicit scheduling language**
("Termin", "Demo", "Beratungsgespräch", "Zeit vereinbaren"). Everything else that needs a human
— billing, cancellation, complaints, an unqualified "ich will mit jemandem sprechen" — stays on
`request_human_contact` exactly as today. If the visitor asks to talk to someone with no
scheduling language, rule R4 (one clarifying question) applies: ask whether they mean a
scheduled call or something else, rather than guessing.

**No new rule text needed for relaying the link** — R7 ("gib die Antwort unverändert weiter")
and R8's "never invent" spirit already cover it once `provide_booking_link` is a capability the
router can call: relay `bookingUrl` verbatim, do not paraphrase or shorten it.

**Config-gap handling folds into existing R9** ("wenn eine Fähigkeit einen Fehler zurückgibt,
erfinde nichts"): when the tool returns `available: false`, the master says booking isn't
available right now and offers `request_human_contact` as the fallback — it never fabricates a
URL.

---

## 5. Config

| Variable | Required | Notes |
|---|---|---|
| `BOOKING_URL` | recommended | Static booking-page URL (e.g. a Calendly link). Unset ⇒ the tool returns `available: false` and the master falls back to `request_human_contact`; rest of the widget is unaffected. |

Add to `navio-orchestrator/.env.example` alongside the other optional-with-graceful-degrade
vars (`PARTNER_AGENT_HOST`, `SALESFORCE_*`).

---

## 6. Observability — Langfuse

`lib/langfuse.ts` keeps one routing table that the trace, the tests, and
`scripts/verify-langfuse.ts` all read from — extend it with a fifth route rather than adding a
parallel path:

- `Route` union (`~L193`): add `"provide_booking_link"`.
- `ROUTES` (`~L209`): add
  `provide_booking_link: { label: "booking link", handler: "the orchestrator itself (static config, no delegation)", tracedIn: "this trace" }`.
- `routeForTool` (`~L240`): add
  `if (toolName === "provide_booking_link") return "provide_booking_link";`.
- `SPAN` (`~L252`): add `provideBookingLink: "hand-off-booking-link"`.
- `TOOL_SPANS` (`~L279`): add `provide_booking_link: SPAN.provideBookingLink`.
- `TOOL_STORIES` (`~L659`): add
  `provide_booking_link: { human: "the booking link", user_goal: "Schedule a meeting with the Sportnavi team" }`
  (used for readable failure stories if the tool throws unexpectedly, despite normally
  degrading via `available: false` rather than throwing).

This makes the booking route show up in `Navio — Multi-Agent` traces the same way `faq` /
`find_partners` / `request_human_contact` already do, with no new code path.

---

## 7. Testing

Matches the existing per-tool pattern already used for `request_human_contact` /
`find_partners`:

- **Unit test** (new or extended `tests/*.test.ts`): `execute()` returns `available: true` with
  `BOOKING_URL` set and the correct `bookingUrl`; returns `available: false` (never throws) when
  unset.
- **`tests/agent-graph.test.ts`**: extend the compiled-manifest assertion so the master's
  authored tool list includes `provide_booking_link`, alongside the existing
  `find_partners`/`request_human_contact` assertions.
- **`tests/langfuse.test.ts`**: extend with the new route's label/handler/span mapping, mirroring
  the existing per-route assertions.
- **`evals/datasets/routing.json`**: this file does not exist yet — it is a phase-2 deliverable
  in the architecture doc's own roadmap, not yet built. When it is created, add ~10-15 labelled
  utterances for booking intent, including the near-miss cases against `request_human_contact`
  ("ich will mit jemandem sprechen" with vs. without a scheduling word) and against `faq`
  ("wie werde ich Partner" — business partnership, not a calendar booking, despite "Termin"
  possibly appearing nearby in a support context).
- **`scripts/verify-langfuse.ts`**: gains a `--expect-route provide_booking_link` case, since the
  script already parameterizes on `--expect-route`.

---

## 8. Docs to update after implementation

- `navio-orchestrator/CLAUDE.md` §3 (layout — add the new tool) and §6 (conventions — note that
  adding this capability was simpler than the general "adding agent N" recipe since it is a
  tool, not a subagent, so no `disableTool()` isolation-boundary sentinels apply).
- `docs/NAVIO-MULTI-AGENT-ARCHITECTURE.md` §4.4 and §11 — mark the Microsoft Graph / booking
  subagent plan as superseded by this document, so the old plan doesn't read as current.

---

## 9. Out of scope / explicitly not built

- Any Microsoft Graph / calendar-provider read or write access.
- Any per-topic or per-language variation in the booking link (confirmed: one static URL for
  everything).
- Any approval gate on `provide_booking_link` (confirmed not needed — see §2).
- A `subagents/booking/` directory of any kind.
