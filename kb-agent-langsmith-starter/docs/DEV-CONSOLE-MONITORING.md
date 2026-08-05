# How the Dev Console Captures Agent Actions — Monitoring Explained

This document explains, end to end, how every agent action in this project is captured and
made visible: what you see live in the **eve dev console** (`npm run dev:ui`), and how the
same activity flows into **LangSmith EU** as traces, turn summaries, and failure runs.

**Source of truth:** `agent/instrumentation.ts`, `agent/hooks/langsmith.ts`,
`lib/langsmith.ts`. If this document and the code disagree, the code wins.

---

## 1. The big picture — one event stream, three consumers

eve does not use exceptions or hidden logs for agent activity. Everything the agent does —
receiving a message, running a model step, calling a tool, streaming text, failing — is
emitted as an **event on the session's SSE stream** and as **OpenTelemetry spans**. Three
consumers watch that activity:

```
                         ┌────────────────────────────────────────────┐
                         │              eve agent runtime             │
                         │  (turn loop: model steps, tools, streaming)│
                         └───────┬───────────────┬───────────────┬────┘
                                 │               │               │
                 stream events   │      OTel spans (gen_ai.*)    │   hook events
                 (SSE, /eve/v1)  │               │               │
                                 ▼               ▼               ▼
                    ┌─────────────────┐  ┌────────────────┐  ┌─────────────────────┐
                    │ 1. DEV CONSOLE  │  │ 2. OTLP TRACES │  │ 3. LANGSMITH HOOKS  │
                    │ live UI at      │  │ instrumentation│  │ hooks/langsmith.ts  │
                    │ npm run dev:ui  │  │ .ts → LangSmith│  │ turn summary +      │
                    │ renders every   │  │ EU /otel       │  │ failure capture     │
                    │ event as it     │  │ (span filter,  │  │ (TurnJournal,       │
                    │ happens         │  │ human names)   │  │ never throws)       │
                    └─────────────────┘  └────────────────┘  └─────────────────────┘
```

All three see the **same underlying activity**; they differ in audience and persistence:

| Consumer | Audience | Persistence | Content |
|---|---|---|---|
| Dev console | you, while developing | none (live only) | every event, verbatim, including ones the widget never renders |
| OTLP traces | LangSmith EU | permanent traces | the execution graph: turn → steps → model calls → tools, with timing and token usage |
| Hooks | LangSmith EU | permanent runs | one human-readable **summary run per turn** + one **failure run per error** |

---

## 2. The dev console (`npm run dev:ui`)

The dev console is eve's built-in development host UI (Next.js). It attaches to the agent's
`/eve/v1/*` API — **the same API the production widget uses** — and subscribes to the
session's Server-Sent-Events stream. It is not a separate logging system; it is simply a
client that renders **every** event type instead of only the ones a chat bubble needs.

### What one turn looks like on the stream

When you send a message, the runtime emits (roughly, in order):

1. `message.received` — your user message enters the turn.
2. `step.started` — a model step begins (the system prompt + history are assembled and
   sent to Azure OpenAI). The FAQ agent has exactly **one** step per turn (no tools).
3. *(tool-using agents only, e.g. the partner agent)* `action.*` / `action.result` — a tool
   call and its result. The dev console shows the tool name, its full JSON input, and its
   full output — this is where you can watch `find_partners` return its candidate list.
4. `message.appended` / streaming deltas — assistant text as it is generated; the console
   renders it token-by-token exactly like the widget does.
5. `step.completed` — the step ends, carrying **token usage** (input / output / cached).
6. `message.completed` — the finished assistant text block.
7. `turn.completed` — the turn is done.

Failures are events too, never exceptions: `step.failed`, `turn.failed`, `session.failed`,
and tool errors ride inside `action.result` with `isError: true`.

### Why the dev console shows more than the widget

The console renders **all** event types; the production widget only renders text messages.
That difference has bitten us before (workspace CLAUDE.md §10.2): the partner agent once
called eve's built-in `ask_question` tool, which emits an `input.requested` event and ends
the turn with **zero** assistant text. The dev console rendered a neat question prompt; the
widget showed an empty bubble forever. Lesson: **something looking fine in the dev console
does not prove the widget can render it** — the console is a superset viewer.

### What the dev console gives you

- **Live message transcript** with streaming output, per session.
- **Tool call inspection** — name, arguments, raw result, error flag (partner agent only;
  the FAQ agent deliberately has 0 tools — 11 `disableTool()` sentinels in `agent/tools/`).
- **Step and turn boundaries** with token usage per step.
- **Failure events verbatim** (`code` + `message`), at the moment they happen.
- **Session management** — start fresh sessions, replay a conversation flow.
- Confirmation of agent config: `npx eve info` lists the agent and its disabled tools.

The console persists nothing. For anything you want to keep, query, or price — that is what
layers 2 and 3 (LangSmith) are for.

---

## 3. Layer 2 — OTLP traces (`agent/instrumentation.ts`)

eve's AI SDK telemetry already emits standard `gen_ai.*` spans for every model call. The
instrumentation file's job is **not** to create telemetry — it points a standard OTLP
exporter at LangSmith EU (`https://eu.api.smith.langchain.com/otel/v1/traces`) and cleans
the stream on the way out. The mere presence of the file enables eve telemetry; with no
`LANGSMITH_API_KEY` no exporter is registered and the agent runs credential-free.

The pipeline, in order:

### 3.1 Span filtering (`AiSpanFilter` + `SpanFilterState`)

eve's Workflow SDK produces a lot of infrastructure noise spans. The filter keeps:

- any span named `ai.*` or carrying `ai.` / `gen_ai.` / `eve.` / `app.` attributes;
- with `LANGSMITH_TRACE_COMPLETENESS=complete` (the default), also the structural graph
  (`workflow.*`, `step.*`, `fetch *`) so the whole execution flow is one inspectable trace;
- **every ancestor of a kept span.** This is load-bearing: LangSmith silently drops any span
  whose parent never arrives, so a naive AI-only filter would export *nothing*.
  `SpanFilterState` marks the whole ancestor chain as must-export when an AI span ends
  (children end before parents, so ancestors see the mark in time).

Escape hatch: `LANGSMITH_EXPORT_ALL=true` exports everything, for debugging the filter.

### 3.2 Cost de-duplication (`withoutAggregateUsage`)

eve's `invoke_agent` aggregator span carries the *same* token usage as the inner per-call
`chat` span. Left alone, LangSmith prices both and the trace double-counts cost (~2×). The
filter strips usage attributes from the aggregator so only the real model-call spans are
priced. Opt out with `LANGSMITH_DEDUPE_USAGE=false`.

### 3.3 Human span names (`withHumanName`)

Just before export, span **names** are rewritten from framework-speak to business language
(via `humanSpanName` in `lib/langsmith.ts`) so a trace reads like a story, not a stack
trace. Attributes and identity are untouched. Disable with `LANGSMITH_HUMAN_NAMES=false`
to A/B against raw names.

### 3.4 Trace anchors — one request = one trace

LangSmith maps an OTLP span to a run with a **deterministic id** derived from the span id
(`otelRunId`). When the filter sees eve's `ai.eve.turn` span start, it walks up to the trace
root, computes the root's future LangSmith run id + `dotted_order`, and publishes it as a
**trace anchor** keyed by session id (a small file store under `.data/anchors`). The hook
layer (§4) uses that anchor to pre-create the trace root — which is how the human summary
run and the raw OTLP spans end up in **the same single trace** per request.

### 3.5 Searchable metadata + system-prompt capture

On every `step.started`, the instrumentation returns `runtimeContext` entries
(`app.channel.kind`, `app.turn.sequence`, `app.step.purpose`, `app.action`) that ride onto
the AI spans as searchable run metadata. Keys starting with `eve.` are reserved and
silently dropped — always use the `app.` prefix.

The assembled system prompt is passed to the AI SDK as a separate `instructions` parameter,
so `gen_ai` spans never contain it. When content capture is on, `step.started` stashes it in
`systemPromptStore` so the hook can attach it to the turn's summary run.

---

## 4. Layer 3 — hooks (`agent/hooks/langsmith.ts`)

Because eve reports failures **as stream events, never exceptions**, this hook file is the
*only* path from an agent failure to LangSmith. Traces keep flowing if it is deleted — which
would silently hide every failure. Do not delete it.

**Iron rule: hooks never throw.** Every handler is wrapped in a `guard` that swallows
errors — a thrown hook would itself become a `turn.failed`, and a throw inside a
failure-cascade handler would become a `session.failed`. Observability must never break the
agent.

### 4.1 The TurnJournal — one summary run per turn

The hook subscribes to the turn's events and accumulates its story in a `TurnJournal`
(`lib/langsmith.ts`):

| Event | What is journaled |
|---|---|
| `message.received` | starts a fresh entry; records the user message + start time |
| `step.completed` | step count; input / output / cached token usage |
| `action.result` | tool name used; tool-error count |
| `message.completed` | the assistant's reply text (last block wins) |

On `turn.completed` (or `turn.failed`) the journal is finalized into one LangSmith run named
`Customer Request: "<first 60 chars of the user message>"`, containing:

- **inputs:** the user message (+ the full system prompt if capture is on),
- **outputs:** the agent's reply + outcome (`answered` / `failed`),
- **metadata:** duration, model steps, tools used, tool errors, token counts (input /
  output / cached / total), an at-a-glance `app.cost.estimate_usd` (server-side pricing on
  the LLM child spans stays authoritative), agent name, channel kind, session id, and
  `thread_id` = session id — which makes LangSmith group all of a session's turns into one
  **thread**.

With a trace anchor available, the summary run **pre-creates the OTLP trace root** using the
exact id/dotted_order the root span will map to. First writer wins: LangSmith rejects the
later OTLP duplicate, and all the raw spans attach as children — so the top of every trace
is the human-readable request/reply summary, with the full execution graph underneath.

### 4.2 Failure capture — failures are stories, not stack traces

Four failure paths each create a dedicated failure run, nested inside the request's trace
when the anchor is known:

| Event | Captured as |
|---|---|
| `action.result` with `isError: true` | `tool` failure (tool name + raw output) |
| `step.failed` | `step` failure (error code + data) |
| `turn.failed` | `turn` failure, **and** the summary run finalizes as `failed` |
| `session.failed` | `session` failure |

`turn.cancelled` is deliberately not captured — a user cancel is not a failure.

Failure payloads are humanized through the `TOOL_STORIES` table in `lib/langsmith.ts`: per
tool, an error can map to a headline, an `error_type`, a user-friendly message, and a
recommended action. Extend that table whenever a tool is added.

---

## 5. Privacy and safety invariants

These are deliberate and must not regress:

1. **No key ⇒ no-op.** Without `LANGSMITH_API_KEY`, no exporter is registered and every hook
   handler silently returns. A fresh clone runs fully credential-free.
2. **EU only.** All endpoints point at `eu.api.smith.langchain.com` — never the SDK's US
   default.
3. **Content capture is opt-in.** Unless `LANGSMITH_RECORD_IO=true`, user messages, replies,
   and the system prompt are replaced with a redaction marker, and even the run *name* falls
   back to `(<n> steps)` so no user text leaks through a title. Metadata (timing, tokens,
   tool names) is always recorded — it contains no user content.
4. **Hooks never throw.**
5. **One request = one trace**, via the deterministic OTLP span-id → run-id mapping.

---

## 6. Configuration reference

| Env var | Default | Effect |
|---|---|---|
| `LANGSMITH_API_KEY` | unset | unset ⇒ all monitoring is a no-op |
| `LANGSMITH_PROJECT` | agent name | LangSmith project runs/traces land in |
| `LANGSMITH_RECORD_IO` | `false` | `true` ⇒ capture message content + system prompt |
| `LANGSMITH_TRACE_COMPLETENESS` | `complete` | `ai` ⇒ export only AI spans + ancestors |
| `LANGSMITH_DEDUPE_USAGE` | `true` | `false` ⇒ keep usage on aggregator spans (double-counts cost) |
| `LANGSMITH_HUMAN_NAMES` | `true` | `false` ⇒ raw framework span names |
| `LANGSMITH_EXPORT_ALL` | unset | `true` ⇒ bypass the span filter entirely |
| `EVE_LS_SPAN_DEBUG` | unset | `1` ⇒ append every KEEP/DROP decision to `.data/spans.log` |

---

## 7. Debugging monitoring itself

- **"Nothing shows up in LangSmith."** Two failure modes look identical from the UI: the
  exporter never saw the span, vs. the backend hasn't ingested it. Set `EVE_LS_SPAN_DEBUG=1`
  and read `.data/spans.log` — it records every span's KEEP/DROP verdict locally.
- **"Spans are missing from a trace."** Remember LangSmith drops spans whose parent never
  arrived; check the ancestor chain with `LANGSMITH_EXPORT_ALL=true`.
- **"It works in the dev console but not the widget."** The console renders event types the
  widget doesn't (see §2). Reproduce in a real browser against `/widget` — and never debug a
  streaming problem with curl alone (browsers drop idle SSE connections; curl doesn't).
- **Cost looks ~2× too high.** Usage de-dup is probably off — check `LANGSMITH_DEDUPE_USAGE`.
- **Quick sanity checks:** `npx eve info` (agent + disabled tools), `npm run live-check`
  (one real turn), `npm run cache:check` (prompt size + Azure cache hit).

---

## 8. Related documents

- `../docs/reference/EVE_LANGSMITH_TRACING_GUIDE.md` (workspace root) — the full guide this
  project is the reference implementation of.
- `CLAUDE.md` §6 — observability invariants, condensed.
- Workspace `CLAUDE.md` §10 — hard-won lessons (the `ask_question` empty-bubble bug, SSE
  keep-alive, TPM-sized tool results).
