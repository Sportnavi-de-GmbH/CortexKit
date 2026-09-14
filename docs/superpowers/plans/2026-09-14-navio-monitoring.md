# Navio Agent Monitoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every FAQ turn and every V3 partner turn of the Navio widget becomes a step-by-step trace in a dedicated Supabase project, feedback is persisted against it, and a password-protected `/monitoring` dashboard inside the widget app shows it.

**Architecture:** A `lib/monitoring/` module in the widget app owns capture (two pure mappers → one `TraceDraft` shape), persistence (one Supabase RPC per write, service-role, never throws, no-op without credentials), feedback linking, cookie auth and read queries. The FAQ side hooks eve's stream events (`agent/hooks/monitoring.ts`, sibling of the Langfuse hook); the partner side maps the `WorkflowTrace` V3 already returns, inside the existing adapter. V3 gets one additive change: token `usage` on model calls. The dashboard is Next 15 App Router pages under `app/monitoring/` reading through the same server-only query module.

**Tech Stack:** Next 15.5 (App Router, `middleware.ts`), React 19, Tailwind 4, lucide-react, `@supabase/supabase-js` (new dep in the widget), Postgres functions (plpgsql), vitest, tsx scripts, Supabase MCP `supabase-monitoring` for applying migrations.

Spec: `docs/superpowers/specs/2026-09-14-navio-monitoring-design.md`.

## Global Constraints

- Branch `v3-partner-retrieval`. Commit messages: no Claude/Anthropic attribution trailers (repo rule, CLAUDE.md §13 — overrides the harness default).
- Widget app root: `kb-agent-langsmith-starter/` (all widget paths below are relative to it). V3 root: `SportnaviPartnerRecomandationBot/partner-recommendation-agent-v3/`.
- **Langfuse stays exactly as it is.** Do not edit `lib/langfuse.ts` behaviour, `agent/hooks/langfuse.ts`, `agent/instrumentation.ts` (only *read* their exports).
- **No change** to prompts, recommendation logic, tool behaviour, routing, auth of existing endpoints, widget visuals. The eve-protocol partner agents are not instrumented.
- Env vars (widget): `MONITORING_SUPABASE_URL`, `MONITORING_SUPABASE_SERVICE_ROLE_KEY`, `MONITORING_PASSWORD`, `MONITORING_COOKIE_SECRET`, `MONITORING_ENVIRONMENT` (default `VERCEL_ENV` then `NODE_ENV`). All four monitoring values are already set in the local `.env.local`; the Supabase project is empty (verified 2026-09-14, `list_tables` → `[]`).
- Invariants: (1) no credentials ⇒ silent no-op; (2) monitoring never throws into an agent or route, failures logged shape-only (never visitor text); (3) a write never fails a visitor's answer; (4) the browser never sees a Supabase key; (5) full visitor text is stored, no truncation.
- Password unset ⇒ `/monitoring/*` and the data API return **404**.
- Cookie: signed httpOnly, `SameSite=Lax`, `Secure` in production, 7-day expiry. 5 failed logins per IP per 15 min → 429.
- Dashboard palette: brand-green `#95c11e` = success/AI, brand-orange `#ec6607` = warning/human, neutral red only for errors inside the dashboard; Outfit + Inter; existing Tailwind + lucide; light/dark; works at 400 px.
- Step `kind` ∈ `request|llm|tool|retrieval|transform|response|error|group`; step `status` ∈ `ok|warning|error|skipped`; trace `status` ∈ `running|completed|needs_clarification|partial|failed`.
- Migrations are the source of truth in `supabase/migrations/*.sql`, applied with the `supabase-monitoring` MCP (`apply_migration`).
- Next 15.5.22 is installed; its middleware file is `middleware.ts` (the spec's `proxy.ts` is the Next 16 name and is **not** recognised by 15.5 — `MIDDLEWARE_FILENAME = 'middleware'` in `node_modules/next/dist/lib/constants.js`).
- Tests: `npm test` + `npm run typecheck` green in the widget and in V3 before every commit. Run from each project root.

---

## File map

Widget (`kb-agent-langsmith-starter/`):

| File | Responsibility |
|---|---|
| `supabase/migrations/20260914000100_monitoring_schema.sql` | tables, indexes, RLS |
| `supabase/migrations/20260914000200_monitoring_rpc.sql` | `monitoring_write_trace(jsonb)`, `monitoring_record_feedback(jsonb)`, `monitoring_stats(int)` |
| `lib/monitoring/env.ts` | env readers, `isMonitoringEnabled()`, `monitoringEnvironment()`, `agentVersion()` |
| `lib/monitoring/types.ts` | `TraceDraft`, `StepDraft`, `FeedbackDraft`, `MonitoringEvent` |
| `lib/monitoring/pricing.ts` | `estimateCostUsd` re-export + `usageCost()` |
| `lib/monitoring/describe.ts` | step name → `{title, purpose}` |
| `lib/monitoring/store.ts` | Supabase writer: `writeTrace`, `recordFeedback`, `logEvent`; never throws |
| `lib/monitoring/v3-mapper.ts` | `WorkflowTrace` → `TraceDraft` |
| `lib/monitoring/faq-mapper.ts` | eve hook events → `TraceDraft` fragments (`FaqTurnDraft`) |
| `lib/monitoring/partner-capture.ts` | glue: adapter result → mapper → store, 5 s cap |
| `lib/monitoring/feedback.ts` | `recordFeedback(parsed)` |
| `lib/monitoring/auth.ts` | password check, cookie sign/verify, login throttle |
| `lib/monitoring/query.ts` | read side: `listTraces`, `getTrace`, `getStats`, `getSession` |
| `agent/hooks/monitoring.ts` | eve hook (FAQ capture) |
| `middleware.ts` | guards `/monitoring/*` + data API |
| `app/api/monitoring/auth/route.ts` | login POST / logout DELETE |
| `app/api/monitoring/traces/route.ts`, `traces/[id]/route.ts`, `stats/route.ts`, `sessions/[id]/route.ts` | data API |
| `app/monitoring/layout.tsx`, `page.tsx`, `login/page.tsx`, `traces/[id]/page.tsx`, `sessions/[id]/page.tsx` | screens |
| `components/monitoring/*.tsx` | `KpiTiles`, `TraceList`, `TraceFilters`, `Timeline`, `StepCard`, `JsonView`, `StatusPill`, `AgentBadge`, `ThemeToggle` |
| `scripts/monitoring-verify.ts`, `scripts/monitoring-reconcile.ts` | integration check, reconciliation |
| `tests/monitoring-*.test.ts` | unit tests |
| `docs/MONITORING.md` | manual |

V3: `lib/llm-port.ts`, `workflow/types.ts`, `workflow/run-workflow.ts`, `workflow/stages/{0,1,2,6}-*.ts`, `tests/_fakes.ts`, `tests/usage.test.ts`.

---

### Task 1: Supabase schema migration

**Files:**
- Create: `supabase/migrations/20260914000100_monitoring_schema.sql`

**Interfaces:**
- Produces: tables `agent_sessions`, `prompt_versions`, `traces`, `trace_steps`, `feedback`, `errors`, `events` exactly as in spec §4, plus `trace_steps.step_key text` (client-stable key, unique per trace — what lets a partial re-write upsert steps) and `trace_steps.parent_key text`.

- [ ] **Step 1: Write the migration**

```sql
-- Navio agent monitoring — schema (spec docs/superpowers/specs/2026-09-14-navio-monitoring-design.md §4)
create extension if not exists pgcrypto;

create table if not exists agent_sessions (
  id text primary key,
  agent text not null check (agent in ('faq','partner')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  turn_count int not null default 0,
  origin text,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists prompt_versions (
  id uuid primary key default gen_random_uuid(),
  agent text not null,
  sha256 text not null unique,
  size_chars int not null,
  approx_tokens int not null,
  sections text[] not null default '{}',
  content text not null,
  first_seen_at timestamptz not null default now()
);

create table if not exists traces (
  id uuid primary key default gen_random_uuid(),
  session_id text not null references agent_sessions(id),
  agent text not null check (agent in ('faq','partner')),
  agent_version text,
  turn_id text not null,
  turn_index int,
  status text not null check (status in ('running','completed','needs_clarification','partial','failed')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  duration_ms int,
  first_token_ms int,
  user_input text,
  final_output text,
  prompt_version_id uuid references prompt_versions(id),
  models text[] not null default '{}',
  tools_called text[] not null default '{}',
  step_count int not null default 0,
  tool_call_count int not null default 0,
  error_count int not null default 0,
  warning_count int not null default 0,
  tokens_input int,
  tokens_output int,
  tokens_cached int,
  cost_estimate_usd numeric(12,6),
  feedback_thumb text check (feedback_thumb in ('up','down')),
  metadata jsonb not null default '{}'::jsonb,
  unique (session_id, turn_id)
);
create index if not exists traces_started_idx on traces (started_at desc);
create index if not exists traces_agent_started_idx on traces (agent, started_at desc);
create index if not exists traces_session_turn_idx on traces (session_id, turn_index);
create index if not exists traces_status_idx on traces (status);
create index if not exists traces_thumb_idx on traces (feedback_thumb);

create table if not exists trace_steps (
  id uuid primary key default gen_random_uuid(),
  trace_id uuid not null references traces(id) on delete cascade,
  parent_step_id uuid references trace_steps(id) on delete cascade,
  step_key text not null,
  parent_key text,
  sequence int not null,
  kind text not null check (kind in ('request','llm','tool','retrieval','transform','response','error','group')),
  name text not null,
  title text not null,
  purpose text not null default '',
  status text not null check (status in ('ok','warning','error','skipped')),
  started_at timestamptz,
  duration_ms int,
  input jsonb,
  output jsonb,
  tool_name text,
  model text,
  tokens_input int,
  tokens_output int,
  tokens_cached int,
  cost_estimate_usd numeric(12,6),
  warnings text[] not null default '{}',
  error jsonb,
  metadata jsonb not null default '{}'::jsonb,
  unique (trace_id, step_key)
);
create index if not exists trace_steps_tree_idx on trace_steps (trace_id, parent_step_id, sequence);

create table if not exists feedback (
  id uuid primary key default gen_random_uuid(),
  trace_id uuid references traces(id) on delete set null,
  session_id text not null,
  turn_id text not null,
  agent text not null,
  thumb text check (thumb in ('up','down')),
  reason text,
  comment text,
  epoch int not null default 0,
  agent_version text,
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);
create index if not exists feedback_trace_idx on feedback (trace_id);
create index if not exists feedback_session_turn_idx on feedback (session_id, turn_id);

create table if not exists errors (
  id uuid primary key default gen_random_uuid(),
  trace_id uuid references traces(id) on delete cascade,
  step_id uuid references trace_steps(id) on delete set null,
  level text not null check (level in ('error','warning')),
  type text not null default 'unclassified',
  message text not null,
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);
create index if not exists errors_created_idx on errors (created_at desc);
create index if not exists errors_trace_idx on errors (trace_id);

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  trace_id uuid,
  session_id text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists events_created_idx on events (created_at desc);

-- Service-role only: RLS on, no policies.
alter table agent_sessions enable row level security;
alter table prompt_versions enable row level security;
alter table traces enable row level security;
alter table trace_steps enable row level security;
alter table feedback enable row level security;
alter table errors enable row level security;
alter table events enable row level security;
```

- [ ] **Step 2: Apply it** with the MCP tool `mcp__supabase-monitoring__apply_migration` (`name: "monitoring_schema"`, `query` = the file content). Then `mcp__supabase-monitoring__list_tables` (`schemas: ["public"]`) — Expected: the 7 tables.

- [ ] **Step 3: Commit**

```bash
git add kb-agent-langsmith-starter/supabase/migrations/20260914000100_monitoring_schema.sql
git commit -m "monitoring: Supabase schema for agent traces, steps, feedback, errors, events"
```

---

### Task 2: Write RPCs (`monitoring_write_trace`, `monitoring_record_feedback`, `monitoring_stats`)

**Files:**
- Create: `supabase/migrations/20260914000200_monitoring_rpc.sql`

**Interfaces:**
- Produces: `monitoring_write_trace(p jsonb) returns uuid` — one transaction: upsert session, upsert trace by `(session_id, turn_id)` **merging** (a null in `p` never overwrites a stored value; arrays/ints are replaced when present), upsert steps by `(trace_id, step_key)` resolving `parent_key` → `parent_step_id`, insert errors, upsert prompt version, back-link unlinked feedback rows, refresh `feedback_thumb`, insert events. Returns the trace id.
- `monitoring_record_feedback(p jsonb) returns jsonb` → `{trace_id, linked}`.
- `monitoring_stats(p_hours int) returns jsonb`.

Payload contract for `monitoring_write_trace` (mirrors `TraceDraft` in Task 3):

```json
{ "session": {"id":"s","agent":"faq","origin":null,"metadata":{}},
  "trace": {"session_id":"s","agent":"faq","agent_version":"abc","turn_id":"turn_1","turn_index":1,
            "status":"completed","started_at":"…","ended_at":"…","duration_ms":1,"first_token_ms":null,
            "user_input":"…","final_output":"…","models":["gpt-4.1"],"tools_called":[],
            "step_count":4,"tool_call_count":0,"error_count":0,"warning_count":0,
            "tokens_input":1,"tokens_output":1,"tokens_cached":0,"cost_estimate_usd":0.1,"metadata":{}},
  "prompt": {"agent":"faq","sha256":"…","size_chars":1,"approx_tokens":1,"sections":[],"content":"…"} ,
  "steps": [ {"step_key":"request-received","parent_key":null,"sequence":1,"kind":"request","name":"request-received",
              "title":"…","purpose":"…","status":"ok","started_at":null,"duration_ms":0,"input":{},"output":{},
              "tool_name":null,"model":null,"tokens_input":null,"tokens_output":null,"tokens_cached":null,
              "cost_estimate_usd":null,"warnings":[],"error":null,"metadata":{}} ],
  "errors": [ {"step_key":"failure","level":"error","type":"timeout","message":"…","metadata":{}} ],
  "events": [ {"type":"trace.write_failed","payload":{}} ] }
```

- [ ] **Step 1: Write the migration**

```sql
-- monitoring_write_trace: one transaction per write. Merge semantics so the FAQ
-- hook can write a `running` row first and fill it in over several serverless
-- invocations (CLAUDE.md serverless traps).
create or replace function monitoring_write_trace(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_trace jsonb := p->'trace';
  v_session jsonb := p->'session';
  v_prompt jsonb := p->'prompt';
  v_trace_id uuid;
  v_prompt_id uuid;
  v_inserted boolean := false;
  s jsonb; e jsonb; ev jsonb;
  v_parent uuid; v_step_id uuid;
  v_thumb text;
begin
  if v_session is not null then
    insert into agent_sessions (id, agent, origin, metadata)
    values (v_session->>'id', v_session->>'agent', v_session->>'origin', coalesce(v_session->'metadata','{}'::jsonb))
    on conflict (id) do update set
      last_seen_at = now(),
      origin = coalesce(excluded.origin, agent_sessions.origin),
      metadata = agent_sessions.metadata || excluded.metadata;
  end if;

  if v_prompt is not null then
    insert into prompt_versions (agent, sha256, size_chars, approx_tokens, sections, content)
    values (v_prompt->>'agent', v_prompt->>'sha256', (v_prompt->>'size_chars')::int, (v_prompt->>'approx_tokens')::int,
            coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(v_prompt->'sections','[]'::jsonb)) x), '{}'),
            v_prompt->>'content')
    on conflict (sha256) do update set sha256 = excluded.sha256
    returning id into v_prompt_id;
  end if;

  select id into v_trace_id from traces
   where session_id = v_trace->>'session_id' and turn_id = v_trace->>'turn_id';

  if v_trace_id is null then
    insert into traces (session_id, agent, agent_version, turn_id, turn_index, status, started_at, ended_at, duration_ms,
      first_token_ms, user_input, final_output, prompt_version_id, models, tools_called, step_count, tool_call_count,
      error_count, warning_count, tokens_input, tokens_output, tokens_cached, cost_estimate_usd, metadata)
    values (v_trace->>'session_id', v_trace->>'agent', v_trace->>'agent_version', v_trace->>'turn_id',
      (v_trace->>'turn_index')::int, coalesce(v_trace->>'status','running'),
      coalesce((v_trace->>'started_at')::timestamptz, now()), (v_trace->>'ended_at')::timestamptz,
      (v_trace->>'duration_ms')::int, (v_trace->>'first_token_ms')::int, v_trace->>'user_input', v_trace->>'final_output',
      v_prompt_id,
      coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(v_trace->'models','[]'::jsonb)) x), '{}'),
      coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(v_trace->'tools_called','[]'::jsonb)) x), '{}'),
      coalesce((v_trace->>'step_count')::int,0), coalesce((v_trace->>'tool_call_count')::int,0),
      coalesce((v_trace->>'error_count')::int,0), coalesce((v_trace->>'warning_count')::int,0),
      (v_trace->>'tokens_input')::int, (v_trace->>'tokens_output')::int, (v_trace->>'tokens_cached')::int,
      (v_trace->>'cost_estimate_usd')::numeric, coalesce(v_trace->'metadata','{}'::jsonb))
    returning id into v_trace_id;
    v_inserted := true;
    update agent_sessions set turn_count = turn_count + 1, last_seen_at = now() where id = v_trace->>'session_id';
  else
    update traces t set
      agent_version = coalesce(v_trace->>'agent_version', t.agent_version),
      turn_index = coalesce((v_trace->>'turn_index')::int, t.turn_index),
      status = coalesce(v_trace->>'status', t.status),
      ended_at = coalesce((v_trace->>'ended_at')::timestamptz, t.ended_at),
      duration_ms = coalesce((v_trace->>'duration_ms')::int, t.duration_ms),
      first_token_ms = coalesce((v_trace->>'first_token_ms')::int, t.first_token_ms),
      user_input = coalesce(v_trace->>'user_input', t.user_input),
      final_output = coalesce(v_trace->>'final_output', t.final_output),
      prompt_version_id = coalesce(v_prompt_id, t.prompt_version_id),
      models = case when v_trace ? 'models' then (select coalesce(array_agg(x),'{}') from jsonb_array_elements_text(v_trace->'models') x) else t.models end,
      tools_called = case when v_trace ? 'tools_called' then (select coalesce(array_agg(x),'{}') from jsonb_array_elements_text(v_trace->'tools_called') x) else t.tools_called end,
      step_count = coalesce((v_trace->>'step_count')::int, t.step_count),
      tool_call_count = coalesce((v_trace->>'tool_call_count')::int, t.tool_call_count),
      error_count = coalesce((v_trace->>'error_count')::int, t.error_count),
      warning_count = coalesce((v_trace->>'warning_count')::int, t.warning_count),
      tokens_input = coalesce((v_trace->>'tokens_input')::int, t.tokens_input),
      tokens_output = coalesce((v_trace->>'tokens_output')::int, t.tokens_output),
      tokens_cached = coalesce((v_trace->>'tokens_cached')::int, t.tokens_cached),
      cost_estimate_usd = coalesce((v_trace->>'cost_estimate_usd')::numeric, t.cost_estimate_usd),
      metadata = t.metadata || coalesce(v_trace->'metadata','{}'::jsonb)
    where t.id = v_trace_id;
  end if;

  -- duration: derive when the writer could not
  update traces set duration_ms = greatest(0, (extract(epoch from (ended_at - started_at)) * 1000)::int)
   where id = v_trace_id and duration_ms is null and ended_at is not null;

  for s in select * from jsonb_array_elements(coalesce(p->'steps','[]'::jsonb)) loop
    v_parent := null;
    if s->>'parent_key' is not null then
      select id into v_parent from trace_steps where trace_id = v_trace_id and step_key = s->>'parent_key';
    end if;
    insert into trace_steps (trace_id, parent_step_id, step_key, parent_key, sequence, kind, name, title, purpose, status,
      started_at, duration_ms, input, output, tool_name, model, tokens_input, tokens_output, tokens_cached,
      cost_estimate_usd, warnings, error, metadata)
    values (v_trace_id, v_parent, s->>'step_key', s->>'parent_key', (s->>'sequence')::int, s->>'kind', s->>'name',
      s->>'title', coalesce(s->>'purpose',''), s->>'status', (s->>'started_at')::timestamptz, (s->>'duration_ms')::int,
      s->'input', s->'output', s->>'tool_name', s->>'model', (s->>'tokens_input')::int, (s->>'tokens_output')::int,
      (s->>'tokens_cached')::int, (s->>'cost_estimate_usd')::numeric,
      coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(s->'warnings','[]'::jsonb)) x), '{}'),
      s->'error', coalesce(s->'metadata','{}'::jsonb))
    on conflict (trace_id, step_key) do update set
      parent_step_id = coalesce(excluded.parent_step_id, trace_steps.parent_step_id),
      sequence = excluded.sequence, kind = excluded.kind, name = excluded.name, title = excluded.title,
      purpose = excluded.purpose, status = excluded.status,
      started_at = coalesce(excluded.started_at, trace_steps.started_at),
      duration_ms = coalesce(excluded.duration_ms, trace_steps.duration_ms),
      input = coalesce(excluded.input, trace_steps.input), output = coalesce(excluded.output, trace_steps.output),
      tool_name = coalesce(excluded.tool_name, trace_steps.tool_name), model = coalesce(excluded.model, trace_steps.model),
      tokens_input = coalesce(excluded.tokens_input, trace_steps.tokens_input),
      tokens_output = coalesce(excluded.tokens_output, trace_steps.tokens_output),
      tokens_cached = coalesce(excluded.tokens_cached, trace_steps.tokens_cached),
      cost_estimate_usd = coalesce(excluded.cost_estimate_usd, trace_steps.cost_estimate_usd),
      warnings = excluded.warnings, error = coalesce(excluded.error, trace_steps.error),
      metadata = trace_steps.metadata || excluded.metadata;
  end loop;

  for e in select * from jsonb_array_elements(coalesce(p->'errors','[]'::jsonb)) loop
    v_step_id := null;
    if e->>'step_key' is not null then
      select id into v_step_id from trace_steps where trace_id = v_trace_id and step_key = e->>'step_key';
    end if;
    insert into errors (trace_id, step_id, level, type, message, metadata)
    values (v_trace_id, v_step_id, coalesce(e->>'level','error'), coalesce(e->>'type','unclassified'), e->>'message',
            coalesce(e->'metadata','{}'::jsonb));
  end loop;

  -- back-link feedback that arrived before the trace existed, then refresh the denormalised verdict
  update feedback set trace_id = v_trace_id
   where trace_id is null and session_id = v_trace->>'session_id' and turn_id = v_trace->>'turn_id';
  select thumb into v_thumb from feedback where trace_id = v_trace_id order by created_at desc limit 1;
  update traces set feedback_thumb = v_thumb where id = v_trace_id;

  for ev in select * from jsonb_array_elements(coalesce(p->'events','[]'::jsonb)) loop
    insert into events (type, trace_id, session_id, payload)
    values (ev->>'type', coalesce((ev->>'trace_id')::uuid, v_trace_id), coalesce(ev->>'session_id', v_trace->>'session_id'),
            coalesce(ev->'payload','{}'::jsonb));
  end loop;

  return v_trace_id;
end $$;

-- monitoring_record_feedback: append a row, link it, refresh traces.feedback_thumb.
create or replace function monitoring_record_feedback(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_trace_id uuid; v_thumb text; v_id uuid;
begin
  select id into v_trace_id from traces where session_id = p->>'session_id' and turn_id = p->>'turn_id';
  insert into feedback (trace_id, session_id, turn_id, agent, thumb, reason, comment, epoch, agent_version, metadata)
  values (v_trace_id, p->>'session_id', p->>'turn_id', coalesce(p->>'agent','faq'), p->>'thumb', p->>'reason', p->>'comment',
          coalesce((p->>'epoch')::int,0), p->>'agent_version', coalesce(p->'metadata','{}'::jsonb))
  returning id into v_id;
  if v_trace_id is not null then
    select thumb into v_thumb from feedback where trace_id = v_trace_id order by created_at desc limit 1;
    update traces set feedback_thumb = v_thumb where id = v_trace_id;
  else
    insert into events (type, session_id, payload)
    values ('feedback.unlinked', p->>'session_id', jsonb_build_object('turn_id', p->>'turn_id', 'feedback_id', v_id));
  end if;
  return jsonb_build_object('feedback_id', v_id, 'trace_id', v_trace_id, 'linked', v_trace_id is not null);
end $$;

-- monitoring_stats: the overview KPIs for the last p_hours hours.
create or replace function monitoring_stats(p_hours int) returns jsonb
language sql security definer set search_path = public stable as $$
  with w as (select * from traces where started_at >= now() - make_interval(hours => p_hours)),
  kpi as (
    select count(*) as executions,
      count(*) filter (where status in ('completed','needs_clarification')) as succeeded,
      count(*) filter (where status = 'failed') as failed,
      count(*) filter (where status = 'running' and started_at < now() - interval '5 minutes') as abandoned,
      avg(duration_ms) as avg_ms,
      percentile_cont(0.95) within group (order by duration_ms) as p95_ms,
      coalesce(sum(cost_estimate_usd),0) as cost_usd,
      count(*) filter (where feedback_thumb = 'up') as thumbs_up,
      count(*) filter (where feedback_thumb = 'down') as thumbs_down
    from w),
  days as (
    select to_char(date_trunc('day', started_at), 'YYYY-MM-DD') as day, agent, count(*) as n
    from w group by 1, 2 order by 1),
  errs as (
    select e.id, e.trace_id, e.level, e.type, e.message, e.created_at, t.agent, t.user_input
    from errors e join traces t on t.id = e.trace_id
    where e.created_at >= now() - make_interval(hours => p_hours)
    order by e.created_at desc limit 10)
  select jsonb_build_object(
    'executions', (select executions from kpi), 'succeeded', (select succeeded from kpi),
    'failed', (select failed from kpi), 'abandoned', (select abandoned from kpi),
    'avg_ms', (select round(avg_ms) from kpi), 'p95_ms', (select round(p95_ms) from kpi),
    'cost_usd', (select cost_usd from kpi), 'thumbs_up', (select thumbs_up from kpi), 'thumbs_down', (select thumbs_down from kpi),
    'per_day', coalesce((select jsonb_agg(jsonb_build_object('day', day, 'agent', agent, 'n', n)) from days), '[]'::jsonb),
    'latest_errors', coalesce((select jsonb_agg(to_jsonb(errs)) from errs), '[]'::jsonb));
$$;

revoke all on function monitoring_write_trace(jsonb) from public, anon, authenticated;
revoke all on function monitoring_record_feedback(jsonb) from public, anon, authenticated;
revoke all on function monitoring_stats(int) from public, anon, authenticated;
```

- [ ] **Step 2: Apply** with `mcp__supabase-monitoring__apply_migration` (`name: "monitoring_rpc"`).

- [ ] **Step 3: Smoke-test the RPC** with `mcp__supabase-monitoring__execute_sql`:

```sql
select monitoring_write_trace('{"session":{"id":"smoke-s","agent":"faq"},
 "trace":{"session_id":"smoke-s","agent":"faq","turn_id":"turn_1","turn_index":1,"status":"running","user_input":"hi"},
 "steps":[{"step_key":"request-received","sequence":1,"kind":"request","name":"request-received","title":"Request received","status":"ok"}]}'::jsonb);
select monitoring_write_trace('{"trace":{"session_id":"smoke-s","agent":"faq","turn_id":"turn_1","status":"completed","final_output":"hello","ended_at":"2026-09-14T10:00:05Z"},
 "steps":[{"step_key":"answer-delivered","sequence":4,"kind":"response","name":"answer-delivered","title":"Answer delivered","status":"ok"}]}'::jsonb);
select status, user_input, final_output, step_count from traces where session_id='smoke-s';
select monitoring_record_feedback('{"session_id":"smoke-s","turn_id":"turn_1","agent":"faq","thumb":"up"}'::jsonb);
select feedback_thumb from traces where session_id='smoke-s';
select monitoring_stats(24)->>'executions';
delete from agent_sessions where id='smoke-s'; -- cascades via traces? no: delete traces first
```
Expected: second select shows `completed / hi / hello`; feedback_thumb `up`; executions `1`. Clean up with `delete from traces where session_id='smoke-s'; delete from feedback where session_id='smoke-s'; delete from events where session_id='smoke-s'; delete from agent_sessions where id='smoke-s';`.

- [ ] **Step 4: Commit**

```bash
git add kb-agent-langsmith-starter/supabase/migrations/20260914000200_monitoring_rpc.sql
git commit -m "monitoring: write/feedback/stats Postgres functions"
```

---

### Task 3: `env.ts`, `types.ts`, `pricing.ts`, `describe.ts`

**Files:**
- Create: `lib/monitoring/env.ts`, `lib/monitoring/types.ts`, `lib/monitoring/pricing.ts`, `lib/monitoring/describe.ts`
- Test: `tests/monitoring-core.test.ts`

**Interfaces (produced):**

```ts
// env.ts
export function isMonitoringEnabled(env?: NodeJS.ProcessEnv): boolean;
export function monitoringSupabase(env?: NodeJS.ProcessEnv): { url: string; key: string } | undefined;
export function monitoringEnvironment(env?: NodeJS.ProcessEnv): string;   // MONITORING_ENVIRONMENT → VERCEL_ENV → NODE_ENV → "development"
export function agentVersion(env?: NodeJS.ProcessEnv): string;            // VERCEL_GIT_COMMIT_SHA[0:12] → local git sha → "dev"
export function dashboardEnabled(env?: NodeJS.ProcessEnv): boolean;       // MONITORING_PASSWORD && MONITORING_COOKIE_SECRET
// types.ts
export type Agent = "faq" | "partner";
export type StepKind = "request"|"llm"|"tool"|"retrieval"|"transform"|"response"|"error"|"group";
export type StepStatus = "ok"|"warning"|"error"|"skipped";
export type TraceStatus = "running"|"completed"|"needs_clarification"|"partial"|"failed";
export interface Usage { input: number; output: number; cached?: number }
export interface StepDraft { step_key; parent_key?; sequence; kind; name; title; purpose; status; started_at?; duration_ms?; input?; output?; tool_name?; model?; tokens_input?; tokens_output?; tokens_cached?; cost_estimate_usd?; warnings?; error?; metadata? }
export interface ErrorDraft { step_key?; level: "error"|"warning"; type: string; message: string; metadata? }
export interface MonitoringEvent { type: string; trace_id?; session_id?; payload? }
export interface PromptDraft { agent; sha256; size_chars; approx_tokens; sections: string[]; content }
export interface TraceDraft { session?: {...}; trace: {...}; prompt?: PromptDraft; steps: StepDraft[]; errors: ErrorDraft[]; events?: MonitoringEvent[] }
export interface FeedbackDraft { session_id; turn_id; agent; thumb: "up"|"down"|null; reason?; comment?; epoch; agent_version?; metadata? }
// pricing.ts
export { estimateCostUsd } from "../langfuse";
export function usageCost(model: string | undefined, usage: Usage | undefined): number | undefined;
// describe.ts
export function describeStep(name: string, extra?: { label?: string; digest?: string }): { title: string; purpose: string };
export const STEP_DESCRIPTIONS: Record<string, { title: string; purpose: string }>;
```

- [ ] **Step 1: Write the failing tests** — `tests/monitoring-core.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { isMonitoringEnabled, monitoringEnvironment, agentVersion, dashboardEnabled } from "../lib/monitoring/env";
import { usageCost } from "../lib/monitoring/pricing";
import { describeStep, STEP_DESCRIPTIONS } from "../lib/monitoring/describe";

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

describe("monitoring env", () => {
  it("is disabled without both url and key", () => {
    expect(isMonitoringEnabled(env({}))).toBe(false);
    expect(isMonitoringEnabled(env({ MONITORING_SUPABASE_URL: "https://x.supabase.co" }))).toBe(false);
    expect(isMonitoringEnabled(env({ MONITORING_SUPABASE_URL: "https://x.supabase.co", MONITORING_SUPABASE_SERVICE_ROLE_KEY: "k" }))).toBe(true);
  });
  it("environment falls back MONITORING_ENVIRONMENT → VERCEL_ENV → NODE_ENV", () => {
    expect(monitoringEnvironment(env({ MONITORING_ENVIRONMENT: "staging", VERCEL_ENV: "preview" }))).toBe("staging");
    expect(monitoringEnvironment(env({ VERCEL_ENV: "preview", NODE_ENV: "production" }))).toBe("preview");
    expect(monitoringEnvironment(env({ NODE_ENV: "test" }))).toBe("test");
  });
  it("agent version prefers the Vercel sha", () => {
    expect(agentVersion(env({ VERCEL_GIT_COMMIT_SHA: "0123456789abcdefXYZ" }))).toBe("0123456789ab");
    expect(agentVersion(env({ MONITORING_NO_GIT: "1" }))).toBe("dev");
  });
  it("dashboard needs password AND cookie secret", () => {
    expect(dashboardEnabled(env({ MONITORING_PASSWORD: "p" }))).toBe(false);
    expect(dashboardEnabled(env({ MONITORING_PASSWORD: "p", MONITORING_COOKIE_SECRET: "s".repeat(32) }))).toBe(true);
  });
});

describe("pricing", () => {
  it("prices known models and returns undefined for unknown/absent usage", () => {
    expect(usageCost("gpt-4.1-mini", { input: 1_000_000, output: 0 })).toBeCloseTo(0.4, 6);
    expect(usageCost("mystery", { input: 10, output: 10 })).toBeUndefined();
    expect(usageCost("gpt-4.1", undefined)).toBeUndefined();
  });
});

describe("describe", () => {
  const NAMES = ["request-received","load-knowledge-base","generate-answer","answer-delivered","failure","decompose",
    "task","detect-city","reformulate","nearby-cities","search","rerank","respond","answer-composed","tool"];
  it.each(NAMES)("has a title and a one-sentence purpose for %s", (n) => {
    const d = describeStep(n);
    expect(d.title.length).toBeGreaterThan(2);
    expect(d.purpose.endsWith(".")).toBe(true);
    expect(d.purpose.split(". ").length).toBe(1);
  });
  it("interpolates the task label and the KB digest", () => {
    expect(describeStep("task", { label: "Yoga in Bochum" }).title).toBe("Task — Yoga in Bochum");
    expect(describeStep("load-knowledge-base", { digest: "abc123" }).purpose).toContain("abc123");
  });
  it("falls back to a generic description for unknown names", () => {
    expect(describeStep("something-new")).toEqual({ title: "something-new", purpose: "This step has no description yet." });
    expect(Object.keys(STEP_DESCRIPTIONS).length).toBeGreaterThanOrEqual(NAMES.length);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run tests/monitoring-core.test.ts` — Expected: FAIL (modules not found).

- [ ] **Step 3: Write `lib/monitoring/env.ts`**

```ts
// Monitoring (Supabase) configuration. Mirrors lib/langfuse.ts: missing
// credentials ⇒ every monitoring surface is a silent no-op.
import { execSync } from "node:child_process";

export function monitoringSupabase(env: NodeJS.ProcessEnv = process.env): { url: string; key: string } | undefined {
  const url = env.MONITORING_SUPABASE_URL?.trim();
  const key = env.MONITORING_SUPABASE_SERVICE_ROLE_KEY?.trim();
  return url && key ? { url, key } : undefined;
}

export function isMonitoringEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return monitoringSupabase(env) !== undefined;
}

export function monitoringEnvironment(env: NodeJS.ProcessEnv = process.env): string {
  return (env.MONITORING_ENVIRONMENT ?? env.VERCEL_ENV ?? env.NODE_ENV ?? "development").trim() || "development";
}

let cachedGitSha: string | undefined;
/** Widget build identity: Vercel's sha, else the local checkout's, else "dev". */
export function agentVersion(env: NodeJS.ProcessEnv = process.env): string {
  const vercel = env.VERCEL_GIT_COMMIT_SHA?.trim();
  if (vercel) return vercel.slice(0, 12);
  if (env.MONITORING_NO_GIT) return "dev";
  if (cachedGitSha === undefined) {
    try {
      cachedGitSha = execSync("git rev-parse --short=12 HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || "dev";
    } catch {
      cachedGitSha = "dev";
    }
  }
  return cachedGitSha;
}

export function dashboardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.MONITORING_PASSWORD?.trim()) && Boolean(env.MONITORING_COOKIE_SECRET?.trim());
}
```

- [ ] **Step 4: Write `lib/monitoring/types.ts`**

```ts
// The in-memory shapes both capture paths produce. `store.ts` sends a
// TraceDraft verbatim to the `monitoring_write_trace(jsonb)` RPC.
export type Agent = "faq" | "partner";
export type StepKind = "request" | "llm" | "tool" | "retrieval" | "transform" | "response" | "error" | "group";
export type StepStatus = "ok" | "warning" | "error" | "skipped";
export type TraceStatus = "running" | "completed" | "needs_clarification" | "partial" | "failed";

export interface Usage { input: number; output: number; cached?: number }

export interface StepDraft {
  /** Stable per trace; groups use `task:<id>`, children `task:<id>/<stage>`. */
  step_key: string;
  parent_key?: string | null;
  sequence: number;
  kind: StepKind;
  name: string;
  title: string;
  purpose: string;
  status: StepStatus;
  started_at?: string | null;
  duration_ms?: number | null;
  input?: unknown;
  output?: unknown;
  tool_name?: string | null;
  model?: string | null;
  tokens_input?: number | null;
  tokens_output?: number | null;
  tokens_cached?: number | null;
  cost_estimate_usd?: number | null;
  warnings?: string[];
  error?: { message: string; type?: string } | null;
  metadata?: Record<string, unknown>;
}

export interface ErrorDraft {
  step_key?: string;
  level: "error" | "warning";
  type: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface MonitoringEvent {
  type: string;
  trace_id?: string;
  session_id?: string;
  payload?: Record<string, unknown>;
}

export interface PromptDraft {
  agent: Agent;
  sha256: string;
  size_chars: number;
  approx_tokens: number;
  sections: string[];
  content: string;
}

export interface TraceFields {
  session_id: string;
  agent: Agent;
  turn_id: string;
  agent_version?: string;
  turn_index?: number;
  status?: TraceStatus;
  started_at?: string;
  ended_at?: string;
  duration_ms?: number;
  first_token_ms?: number | null;
  user_input?: string;
  final_output?: string;
  models?: string[];
  tools_called?: string[];
  step_count?: number;
  tool_call_count?: number;
  error_count?: number;
  warning_count?: number;
  tokens_input?: number | null;
  tokens_output?: number | null;
  tokens_cached?: number | null;
  cost_estimate_usd?: number | null;
  metadata?: Record<string, unknown>;
}

export interface TraceDraft {
  session?: { id: string; agent: Agent; origin?: string | null; metadata?: Record<string, unknown> };
  trace: TraceFields;
  prompt?: PromptDraft;
  steps: StepDraft[];
  errors: ErrorDraft[];
  events?: MonitoringEvent[];
}

export interface FeedbackDraft {
  session_id: string;
  turn_id: string;
  agent: Agent;
  thumb: "up" | "down" | null;
  reason?: string | null;
  comment?: string | null;
  epoch: number;
  agent_version?: string;
  metadata?: Record<string, unknown>;
}

/** Sum step usage into trace totals. */
export function sumUsage(steps: StepDraft[]): { tokens_input: number; tokens_output: number; tokens_cached: number; cost_estimate_usd: number } {
  let i = 0, o = 0, c = 0, usd = 0;
  for (const s of steps) {
    i += s.tokens_input ?? 0; o += s.tokens_output ?? 0; c += s.tokens_cached ?? 0; usd += s.cost_estimate_usd ?? 0;
  }
  return { tokens_input: i, tokens_output: o, tokens_cached: c, cost_estimate_usd: Number(usd.toFixed(6)) };
}
```

- [ ] **Step 5: Write `lib/monitoring/pricing.ts`**

```ts
// One price table for both agents: lib/langfuse.ts MODEL_PRICES.
import { estimateCostUsd } from "../langfuse";
import type { Usage } from "./types";

export { estimateCostUsd };

/** undefined when there is nothing to price (no usage, or an unknown model — never invent a price). */
export function usageCost(model: string | undefined, usage: Usage | undefined): number | undefined {
  if (!model || !usage) return undefined;
  const usd = estimateCostUsd(model, usage.input, usage.output, usage.cached ?? 0);
  return usd > 0 ? Number(usd.toFixed(6)) : undefined;
}
```

- [ ] **Step 6: Write `lib/monitoring/describe.ts`**

```ts
// The "why" of every step, in plain language, for non-technical readers.
export const STEP_DESCRIPTIONS: Record<string, { title: string; purpose: string }> = {
  "request-received": { title: "Request received", purpose: "The visitor's message reached the agent." },
  "load-knowledge-base": { title: "Load knowledge base", purpose: "The agent's curated Sportnavi knowledge base (version {digest}) is placed in context; no retrieval happens." },
  "generate-answer": { title: "Generate answer", purpose: "One model call writes the answer from the question and the knowledge base." },
  "answer-delivered": { title: "Answer delivered", purpose: "The finished answer was streamed to the widget." },
  failure: { title: "Failure", purpose: "The agent reported an error and the visitor did not get a normal answer." },
  tool: { title: "Tool call", purpose: "The agent called a tool and received its result." },
  decompose: { title: "Split into search tasks", purpose: "One model call splits the message into independent searches (different activity or place)." },
  task: { title: "Task — {label}", purpose: "One independent search, run in parallel with its siblings." },
  "detect-city": { title: "Detect city", purpose: "The place the visitor named is matched against the directory's cities." },
  reformulate: { title: "Reformulate question", purpose: "One model call rewrites the request into a richer search query without changing its intent." },
  "nearby-cities": { title: "Find nearby cities", purpose: "Cities close to the target are added so the search has enough partners to choose from." },
  search: { title: "Similarity search", purpose: "The query is embedded once and compared with partner profiles in each city." },
  rerank: { title: "Combine, dedupe, rerank", purpose: "Candidates from all cities are merged, deduplicated and ordered by relevance and distance." },
  respond: { title: "Write answer", purpose: "One model call phrases the answer from the selected partners' profiles only." },
  "answer-composed": { title: "Answer composed", purpose: "The per-task answers were combined into the reply shown to the visitor." },
};

export function describeStep(name: string, extra: { label?: string; digest?: string } = {}): { title: string; purpose: string } {
  const d = STEP_DESCRIPTIONS[name];
  if (!d) return { title: name, purpose: "This step has no description yet." };
  const fill = (s: string) => s.replace("{label}", extra.label ?? "").replace("{digest}", extra.digest ?? "unknown");
  return { title: fill(d.title).replace(/ — $/, ""), purpose: fill(d.purpose) };
}
```

- [ ] **Step 7: Run** `npx vitest run tests/monitoring-core.test.ts` — Expected: PASS. Then `npm run typecheck`.

- [ ] **Step 8: Commit**

```bash
git add lib/monitoring/env.ts lib/monitoring/types.ts lib/monitoring/pricing.ts lib/monitoring/describe.ts tests/monitoring-core.test.ts
git commit -m "monitoring: env, draft types, pricing and step descriptions"
```

---

### Task 4: `store.ts` — the Supabase writer

**Files:**
- Modify: `package.json` (add `"@supabase/supabase-js": "^2.110.7"` to dependencies; `npm install`)
- Create: `lib/monitoring/store.ts`
- Test: `tests/monitoring-store.test.ts`

**Interfaces (produced):**

```ts
export interface MonitoringClient { rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }> }
export interface MonitoringStore {
  enabled: boolean;
  writeTrace(draft: TraceDraft): Promise<string | undefined>;          // trace id, undefined on no-op/failure
  recordFeedback(draft: FeedbackDraft): Promise<{ traceId?: string; linked: boolean } | undefined>;
  logEvent(event: MonitoringEvent): Promise<void>;                       // buffered; flushed with the next successful write
  stats(hours: number): Promise<Record<string, unknown> | undefined>;
}
export function createStore(opts?: { client?: MonitoringClient; env?: NodeJS.ProcessEnv; log?: (line: string, shape: Record<string, unknown>) => void }): MonitoringStore;
export const store: MonitoringStore;   // process singleton on process.env
export function supabaseAdmin(env?: NodeJS.ProcessEnv): SupabaseClient | undefined;  // for query.ts / scripts
```

- [ ] **Step 1: Write the failing tests** — `tests/monitoring-store.test.ts`

```ts
import { describe, it, expect, vi } from "vitest";
import { createStore, type MonitoringClient } from "../lib/monitoring/store";
import type { TraceDraft } from "../lib/monitoring/types";

const ENV = { MONITORING_SUPABASE_URL: "https://x.supabase.co", MONITORING_SUPABASE_SERVICE_ROLE_KEY: "k" } as unknown as NodeJS.ProcessEnv;
const draft: TraceDraft = {
  session: { id: "s1", agent: "faq" },
  trace: { session_id: "s1", agent: "faq", turn_id: "turn_1", status: "running", user_input: "Was ist Firmenfitness?" },
  steps: [], errors: [],
};
const okClient = (): MonitoringClient & { calls: unknown[] } => {
  const calls: unknown[] = [];
  return { calls, rpc: vi.fn(async (fn, args) => { calls.push({ fn, args }); return { data: "trace-uuid", error: null }; }) };
};

describe("monitoring store", () => {
  it("is a no-op without credentials", async () => {
    const client = okClient();
    const s = createStore({ client, env: {} as NodeJS.ProcessEnv });
    expect(s.enabled).toBe(false);
    expect(await s.writeTrace(draft)).toBeUndefined();
    expect(client.calls).toHaveLength(0);
  });

  it("sends the draft to monitoring_write_trace and returns the id", async () => {
    const client = okClient();
    const s = createStore({ client, env: ENV });
    expect(await s.writeTrace(draft)).toBe("trace-uuid");
    expect(client.calls[0]).toMatchObject({ fn: "monitoring_write_trace", args: { p: draft } });
  });

  it("never throws: retries once, then logs shape-only and buffers a trace.write_failed event", async () => {
    const log = vi.fn();
    const rpc = vi.fn(async () => { throw new Error("boom " + "Was ist Firmenfitness?"); });
    const s = createStore({ client: { rpc }, env: ENV, log });
    await expect(s.writeTrace(draft)).resolves.toBeUndefined();
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls[0])).not.toContain("Firmenfitness");
    // next successful write carries the buffered event
    rpc.mockImplementation(async () => ({ data: "t2", error: null }));
    await s.writeTrace(draft);
    const sent = rpc.mock.calls[2]![1] as { p: TraceDraft };
    expect(sent.p.events?.map((e) => e.type)).toEqual(["trace.write_failed"]);
  });

  it("treats an RPC error object like a failure", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: "permission denied" } }));
    const s = createStore({ client: { rpc }, env: ENV, log: () => {} });
    expect(await s.writeTrace(draft)).toBeUndefined();
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("records feedback through monitoring_record_feedback", async () => {
    const rpc = vi.fn(async () => ({ data: { trace_id: "t1", linked: true }, error: null }));
    const s = createStore({ client: { rpc }, env: ENV });
    expect(await s.recordFeedback({ session_id: "s1", turn_id: "turn_1", agent: "faq", thumb: "up", epoch: 0 })).toEqual({ traceId: "t1", linked: true });
  });
});
```

- [ ] **Step 2: Run** `npx vitest run tests/monitoring-store.test.ts` — Expected: FAIL.

- [ ] **Step 3: Install the dependency** — `npm install @supabase/supabase-js@^2.110.7` (from the widget root). Verify `package.json` has it under `dependencies`.

- [ ] **Step 4: Write `lib/monitoring/store.ts`**

```ts
// The Supabase writer. Invariants (spec §5): no credentials ⇒ no-op; never
// throws; one RPC per write; one retry, then a shape-only log line and an
// in-memory event flushed with the next successful write.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { monitoringSupabase } from "./env";
import type { FeedbackDraft, MonitoringEvent, TraceDraft } from "./types";

export interface MonitoringClient {
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
}

export interface MonitoringStore {
  enabled: boolean;
  writeTrace(draft: TraceDraft): Promise<string | undefined>;
  recordFeedback(draft: FeedbackDraft): Promise<{ traceId?: string; linked: boolean } | undefined>;
  logEvent(event: MonitoringEvent): Promise<void>;
  stats(hours: number): Promise<Record<string, unknown> | undefined>;
}

export function supabaseAdmin(env: NodeJS.ProcessEnv = process.env): SupabaseClient | undefined {
  const cfg = monitoringSupabase(env);
  if (!cfg) return undefined;
  return createClient(cfg.url, cfg.key, { auth: { persistSession: false, autoRefreshToken: false } });
}

const defaultLog = (line: string, shape: Record<string, unknown>) => console.error(line, shape);

export function createStore(opts: { client?: MonitoringClient; env?: NodeJS.ProcessEnv; log?: typeof defaultLog } = {}): MonitoringStore {
  const env = opts.env ?? process.env;
  const log = opts.log ?? defaultLog;
  const client: MonitoringClient | undefined = opts.client ?? (supabaseAdmin(env) as MonitoringClient | undefined);
  const enabled = client !== undefined;
  const pending: MonitoringEvent[] = [];

  async function call(fn: string, p: unknown, shape: Record<string, unknown>): Promise<unknown> {
    if (!client) return undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { data, error } = await client.rpc(fn, { p });
        if (error) throw new Error(error.message);
        return data;
      } catch (e) {
        if (attempt === 1) {
          log(`[monitoring] ${fn} failed`, { ...shape, error: e instanceof Error ? e.name : "unknown" });
          return undefined;
        }
      }
    }
    return undefined;
  }

  return {
    enabled,
    async writeTrace(draft) {
      if (!client) return undefined;
      const events = [...(draft.events ?? []), ...pending.splice(0)];
      const payload: TraceDraft = { ...draft, ...(events.length ? { events } : {}) };
      const data = await call("monitoring_write_trace", payload, {
        agent: draft.trace.agent, turnId: draft.trace.turn_id, steps: draft.steps.length, status: draft.trace.status,
      });
      if (data === undefined) {
        pending.push(...events.filter((e) => e.type !== "trace.write_failed"));
        pending.push({ type: "trace.write_failed", session_id: draft.trace.session_id,
          payload: { turn_id: draft.trace.turn_id, agent: draft.trace.agent, steps: draft.steps.length } });
        return undefined;
      }
      return typeof data === "string" ? data : undefined;
    },
    async recordFeedback(draft) {
      if (!client) return undefined;
      const data = (await call("monitoring_record_feedback", draft, { agent: draft.agent, thumb: draft.thumb })) as
        | { trace_id: string | null; linked: boolean } | undefined;
      if (!data) return undefined;
      return { traceId: data.trace_id ?? undefined, linked: Boolean(data.linked) };
    },
    async logEvent(event) {
      pending.push(event);
    },
    async stats(hours) {
      if (!client) return undefined;
      const { data, error } = await client.rpc("monitoring_stats", { p_hours: hours });
      return error || !data ? undefined : (data as Record<string, unknown>);
    },
  };
}

export const store: MonitoringStore = createStore();
```

Note: `stats` passes `p_hours`, not `p` — `call()` is only for the two `p jsonb` functions.

- [ ] **Step 5: Run** `npx vitest run tests/monitoring-store.test.ts` — Expected: PASS. `npm run typecheck` — PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json lib/monitoring/store.ts tests/monitoring-store.test.ts
git commit -m "monitoring: Supabase store (no-op without creds, never throws, retry + buffered events)"
```

---

### Task 5: V3 — surface token usage per model call (additive)

**Files (V3 root):**
- Modify: `lib/llm-port.ts`, `workflow/types.ts`, `workflow/run-workflow.ts`, `workflow/stages/0-decompose.ts`, `workflow/stages/1-detect-city.ts`, `workflow/stages/2-reformulate.ts`, `workflow/stages/6-respond.ts`, `tests/_fakes.ts`
- Test: `tests/usage.test.ts`

**Interfaces (produced):**
```ts
export interface LlmUsage { input: number; output: number; cached?: number }
// LlmPort — every method may add `usage?: LlmUsage` to its result:
decompose(...): Promise<{ tasks: RawTask[]; usage?: LlmUsage }>
detectCity(...): Promise<{ cityMention: string | null; usage?: LlmUsage }>
reformulate(...): Promise<{ text: string; usage?: LlmUsage }>      // was Promise<string>
answer(...): Promise<{ text: string; usage?: LlmUsage }>           // was Promise<string>
// StageResult / StageRecord / TaskRun / WorkflowTrace gain `usage?: LlmUsage`; StageRecord + StageResult gain `model?: string`.
```
`reformulate`/`answer` change from a bare string to `{ text, usage? }` — the only signature change; stages 2 and 6 and the fake are the only callers (verify with `grep -rn "llm.reformulate\|llm.answer" --include=*.ts . | grep -v node_modules`).

- [ ] **Step 1: Write the failing test** — `tests/usage.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { runWorkflow } from "../workflow/run-workflow";
import { deps, fakeLlm } from "./_fakes";

const U = { input: 100, output: 10, cached: 20 };

describe("token usage is surfaced additively", () => {
  it("stages 0, 2 and 6 carry usage + model; task and trace sums add up", async () => {
    const llm = fakeLlm({ cityMention: "Dortmund", usage: U });
    const t = await runWorkflow({ query: "Yoga in Dortmund" }, { enableDecomposition: true }, deps({ llm }));
    expect(t.status).toBe("ok");
    expect(t.decompose.usage).toEqual(U);
    expect(t.decompose.model).toBe("fake-model");
    const task = t.tasks[0]!;
    const byId = Object.fromEntries(task.stages.map((s) => [s.id, s]));
    expect(byId.reformulate!.usage).toEqual(U);
    expect(byId.respond!.usage).toEqual(U);
    expect(byId.respond!.model).toBe("fake-model");
    expect(byId["detect-city"]!.usage).toBeUndefined(); // stage 0's hint ⇒ no model call
    expect(task.usage).toEqual({ input: 200, output: 20, cached: 40 });
    expect(t.usage).toEqual({ input: 300, output: 30, cached: 60 });
  });

  it("a fake without usage leaves every usage field undefined (existing behaviour)", async () => {
    const t = await runWorkflow({ query: "Yoga in Dortmund" }, { enableDecomposition: true }, deps({ llm: fakeLlm({ cityMention: "Dortmund" }) }));
    expect(t.usage).toBeUndefined();
    expect(t.tasks[0]!.usage).toBeUndefined();
    expect(t.decompose.usage).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run** `npx vitest run tests/usage.test.ts` — Expected: FAIL (`usage` option unknown / undefined sums).

- [ ] **Step 3: `lib/llm-port.ts`** — add the type and read `result.usage`:

```ts
export interface LlmUsage { input: number; output: number; cached?: number }

export interface LlmPort {
  readonly modelName: string;
  decompose(query: string, opts: { pending: Task[]; signal: AbortSignal }): Promise<{ tasks: RawTask[]; usage?: LlmUsage }>;
  detectCity(query: string, opts: { signal: AbortSignal }): Promise<{ cityMention: string | null; usage?: LlmUsage }>;
  reformulate(query: string, opts: { maxChars: number; signal: AbortSignal }): Promise<{ text: string; usage?: LlmUsage }>;
  answer(prompt: string, opts: { signal: AbortSignal }): Promise<{ text: string; usage?: LlmUsage }>;
}

/** AI SDK v7 usage → our shape. Undefined when the provider reported nothing. */
function toUsage(u: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; inputTokenDetails?: { cacheReadTokens?: number } } | undefined): LlmUsage | undefined {
  if (!u || typeof u.inputTokens !== "number") return undefined;
  const cached = u.inputTokenDetails?.cacheReadTokens ?? u.cachedInputTokens;
  return { input: u.inputTokens, output: u.outputTokens ?? 0, ...(typeof cached === "number" ? { cached } : {}) };
}
```
In `createAzureLlmPort`: `decompose` → `const { object, usage } = await generateObject(...); return { tasks: object.tasks, usage: toUsage(usage) };` · `detectCity` → `const { object, usage } = …; return { cityMention: object.cityMention?.trim() || null, usage: toUsage(usage) }` · `reformulate` → `const { text, usage } = await generateText(...); return { text: text.trim(), usage: toUsage(usage) };` · `answer` → `const { text, usage } = await generateText(...); return { text, usage: toUsage(usage) };`. If `usage` typing from `ai` v7 does not match the parameter above, widen the parameter to `unknown` and cast inside `toUsage`.

- [ ] **Step 4: `workflow/types.ts`** — add `import type { LlmUsage } from "../lib/llm-port"; export type { LlmUsage };` and the fields: `StageRecord` gets `usage?: LlmUsage; model?: string;`; `StageResult` gets `usage?: LlmUsage; model?: string;`; `TaskRun` gets `usage?: LlmUsage;`; `WorkflowTrace` gets `usage?: LlmUsage;`.

- [ ] **Step 5: stages** — return `usage`/`model` on the `StageResult`:
  - `0-decompose.ts`: `let usage: LlmUsage | undefined;` set `usage = raw.usage;` right after the model call; add `...(usage ? { usage } : {}), ...(model ? { model } : {})` to the returned object (next to `config`).
  - `1-detect-city.ts`: `const r = await raceAbort(ctx.deps.llm.detectCity(...), signal, "detectCity"); cityMention = r.cityMention; usage = r.usage;` (declare `let usage: LlmUsage | undefined;` above) and return `...(usage ? { usage, model: ctx.deps.llm.modelName } : {})`.
  - `2-reformulate.ts`: `const r = await ctx.deps.llm.reformulate(...); let text = r.text.trim();` and on the reformulated branch return `...(r.usage ? { usage: r.usage } : {}), model: ctx.deps.llm.modelName`.
  - `6-respond.ts`: `const r = await ctx.deps.llm.answer(prompt, ...); const answer = r.text.trim();` and return `...(r.usage ? { usage: r.usage } : {}), model: ctx.deps.llm.modelName`.

- [ ] **Step 6: `workflow/run-workflow.ts`** — in `runStage` copy `...(result.usage ? { usage: result.usage } : {}), ...(result.model ? { model: result.model } : {})` into the record. Add:

```ts
function sumUsage(items: Array<{ usage?: LlmUsage }>): LlmUsage | undefined {
  const withUsage = items.filter((i) => i.usage);
  if (!withUsage.length) return undefined;
  const cachedSeen = withUsage.some((i) => typeof i.usage!.cached === "number");
  const s = withUsage.reduce((a, i) => ({ input: a.input + i.usage!.input, output: a.output + i.usage!.output, cached: (a.cached ?? 0) + (i.usage!.cached ?? 0) }), { input: 0, output: 0, cached: 0 } as LlmUsage);
  return cachedSeen ? s : { input: s.input, output: s.output };
}
```
In `runTask`'s `done()`: `const usage = sumUsage(stages); return { task, totalMs: …, stages, ...(usage ? { usage } : {}), ...partial };`. In `runWorkflow` before the final `return done({...})`: `const u = sumUsage([s0.record, ...tasks]);` and add `...(u ? { usage: u } : {})` to it. Import `LlmUsage` from `./types`.

- [ ] **Step 7: `tests/_fakes.ts`** — `FakeLlmOptions` gets `usage?: LlmUsage;` (import the type); each fake method returns `...(o.usage ? { usage: o.usage } : {})`; `reformulate` and `answer` now return `{ text: <previous string>, ...(o.usage ? { usage: o.usage } : {}) }`.

- [ ] **Step 8: Run** `npm test` and `npm run typecheck` in V3 — Expected: all green including the new file (existing tests unchanged).

- [ ] **Step 9: Commit**

```bash
git add SportnaviPartnerRecomandationBot/partner-recommendation-agent-v3
git commit -m "v3: surface token usage per model call (additive) for widget cost tracking"
```

---

### Task 6: `v3-mapper.ts` — `WorkflowTrace` → `TraceDraft`

**Files:**
- Create: `lib/monitoring/v3-mapper.ts`
- Create fixtures: `tests/fixtures/v3/single-task.json`, `three-tasks.json`, `needs-clarification.json`, `failed.json`. Record them from a real V3 run (V3 dev server on port 3008, after Task 5): `curl -s http://127.0.0.1:3008/api/workflow -H "content-type: application/json" -d "{\"query\":\"Yoga in Bochum\"}" > tests/fixtures/v3/single-task.json`; queries: `"Yoga in Bochum"`, `"Tennis in Dortmund, Boxen in Bochum und Yoga in Essen"`, `"Yoga"` (no city → needs_clarification), and for `failed.json` start V3 with `MEMORY_SUPABASE_SERVICE_ROLE_KEY` blank so `createDeps` throws. If V3 cannot run, hand-write them following `workflow/types.ts` — real recordings strongly preferred.
- Test: `tests/monitoring-v3-mapper.test.ts`

**Interfaces (produced):**
```ts
export type V3WorkflowTrace = /* structural copy of V3's WorkflowTrace incl. usage/model */;
export interface V3MapperInput { trace: V3WorkflowTrace; sessionId: string; turnId: string; turnIndex?: number; origin?: string | null; agentVersion: string; environment: string; upstreamStatus?: number }
export function mapV3Trace(input: V3MapperInput): TraceDraft;
export function mapV3UpstreamError(input: Omit<V3MapperInput, "trace"> & { userInput: string; status: number; body: string; startedAt: string }): TraceDraft;
```
Step keys: `request-received`, `decompose`, `task:<id>` (group), `task:<id>/<stage>` (children, sequence 1..6), `answer-composed`. Task status `needs_clarification` → group `status: "warning"`, `output: { clarification }`; `failed` → group `status: "error"`. Trace status: `ok → completed`, others verbatim. `trace.metadata`: `{ run_id, config, deferred, pending, clarification, env, upstream_status }`.

- [ ] **Step 1: Write the failing tests** — `tests/monitoring-v3-mapper.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { mapV3Trace, mapV3UpstreamError, type V3WorkflowTrace } from "../lib/monitoring/v3-mapper";

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/v3/${n}.json`, import.meta.url), "utf8")) as V3WorkflowTrace;
const base = { sessionId: "s1", turnId: "turn_1", turnIndex: 1, agentVersion: "abc", environment: "test" };

describe("v3 mapper", () => {
  it("single task: request → decompose → one group with six children → answer-composed", () => {
    const t = fx("single-task");
    const d = mapV3Trace({ ...base, trace: t });
    expect(d.trace).toMatchObject({ session_id: "s1", agent: "partner", turn_id: "turn_1", status: "completed" });
    expect(d.trace.user_input).toBe(t.input.query);
    expect(d.trace.final_output).toBe(t.answer);
    expect(d.steps.filter((s) => !s.parent_key).map((s) => s.name)).toEqual(["request-received", "decompose", "task", "answer-composed"]);
    const group = d.steps.find((s) => s.kind === "group")!;
    const children = d.steps.filter((s) => s.parent_key === group.step_key);
    expect(children.map((c) => c.name)).toEqual(["detect-city", "reformulate", "nearby-cities", "search", "rerank", "respond"]);
    expect(children.map((c) => c.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    const search = children.find((c) => c.name === "search")!;
    expect(search.kind).toBe("tool");
    expect(search.tool_name).toBe("similarity_search");
    expect(search.output).toHaveProperty("perCity");
    expect(d.trace.tools_called).toEqual(["similarity_search"]);
    expect(d.trace.step_count).toBe(d.steps.length);
    expect(d.trace.metadata).toMatchObject({ run_id: t.runId, env: "test" });
  });

  it("three tasks: three sibling groups with their own children; models and usage summed", () => {
    const t = fx("three-tasks");
    const d = mapV3Trace({ ...base, trace: t });
    const groups = d.steps.filter((s) => s.kind === "group");
    expect(groups).toHaveLength(3);
    expect(groups.map((g) => g.title)).toEqual(t.tasks.map((x) => `Task — ${x.task.label}`));
    expect(groups.map((g) => g.sequence)).toEqual([3, 4, 5]);
    if (t.usage) expect(d.trace.tokens_input).toBe(t.usage.input);
    expect(d.trace.models!.length).toBeGreaterThan(0);
  });

  it("needs_clarification: group is a warning carrying the clarification; trace status kept", () => {
    const t = fx("needs-clarification");
    const d = mapV3Trace({ ...base, trace: t });
    expect(d.trace.status).toBe("needs_clarification");
    const g = d.steps.find((s) => s.kind === "group")!;
    expect(g.status).toBe("warning");
    expect(g.output).toMatchObject({ clarification: expect.any(String) });
    expect(d.trace.final_output).toBe(t.clarification);
    expect(d.trace.warning_count).toBeGreaterThan(0);
  });

  it("failed: trace failed, error row present", () => {
    const t = fx("failed");
    const d = mapV3Trace({ ...base, trace: t });
    expect(d.trace.status).toBe("failed");
    expect(d.errors.length).toBeGreaterThan(0);
    expect(d.errors.some((e) => e.message === t.error!.message)).toBe(true);
    expect(d.trace.error_count).toBe(d.errors.filter((e) => e.level === "error").length);
  });

  it("copies stage warnings, config, counts, filters verbatim onto the child steps", () => {
    const t = fx("single-task");
    const d = mapV3Trace({ ...base, trace: t });
    const stage = t.tasks[0]!.stages.find((s) => s.id === "search")!;
    const step = d.steps.find((s) => s.step_key === `task:${t.tasks[0]!.task.id}/search`)!;
    expect(step.warnings).toEqual(stage.warnings);
    expect(step.metadata).toMatchObject({ config: stage.config, counts: stage.counts ?? {}, filters: stage.filters ?? {} });
  });

  it("an upstream non-2xx becomes a failed trace with an error and a partner.upstream_error event", () => {
    const d = mapV3UpstreamError({ ...base, userInput: "Yoga in Bochum", status: 502, body: "Bad Gateway", startedAt: "2026-09-14T10:00:00.000Z" });
    expect(d.trace.status).toBe("failed");
    expect(d.errors[0]).toMatchObject({ level: "error", type: "upstream_unavailable" });
    expect(d.events?.[0]?.type).toBe("partner.upstream_error");
    expect(d.steps.map((s) => s.name)).toEqual(["request-received", "failure"]);
  });
});
```

- [ ] **Step 2: Record the fixtures**, run `npx vitest run tests/monitoring-v3-mapper.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Write `lib/monitoring/v3-mapper.ts`**

```ts
// Pure: V3's WorkflowTrace (already returned to the widget) → TraceDraft.
// The types below are a structural copy of V3's workflow/types.ts; the widget
// does not import V3 code.
import { FAILURE_PATTERNS } from "../langfuse";
import { describeStep } from "./describe";
import { usageCost } from "./pricing";
import { sumUsage, type ErrorDraft, type StepDraft, type StepStatus, type TraceDraft, type TraceStatus, type Usage } from "./types";

export interface V3Stage {
  id: "decompose" | "detect-city" | "reformulate" | "nearby-cities" | "search" | "rerank" | "respond";
  title: string; status: StepStatus; durationMs: number; input: unknown; output?: unknown;
  config: Record<string, unknown>; filters?: Record<string, unknown>; counts?: Record<string, number>;
  warnings: string[]; error?: { message: string }; usage?: Usage; model?: string;
}
export interface V3Task { id: string; label: string; query: string; cityMention: string | null; priority: number }
export interface V3TaskRun {
  task: V3Task; status: "ok" | "needs_clarification" | "failed"; totalMs: number; stages: V3Stage[];
  answer?: string; recommendations?: unknown[]; clarification?: string; error?: { message: string }; usage?: Usage;
}
export interface V3WorkflowTrace {
  runId: string; startedAt: string; totalMs: number; status: "ok" | "needs_clarification" | "partial" | "failed";
  input: { query: string; resume?: unknown }; config: Record<string, unknown>; decompose: V3Stage; tasks: V3TaskRun[];
  deferred: V3Task[]; pending: V3Task[]; stages: V3Stage[]; answer?: string; recommendations?: unknown[]; clarification?: string;
  error?: { message: string }; usage?: Usage;
}

export interface V3MapperInput {
  trace: V3WorkflowTrace; sessionId: string; turnId: string; turnIndex?: number; origin?: string | null;
  agentVersion: string; environment: string; upstreamStatus?: number;
}

const STAGE_KIND: Record<V3Stage["id"], StepDraft["kind"]> = {
  decompose: "llm", "detect-city": "retrieval", reformulate: "llm", "nearby-cities": "retrieval", search: "tool", rerank: "transform", respond: "llm",
};

export function classifyError(message: string): string {
  return FAILURE_PATTERNS.find((p) => p.match.test(message))?.error_type ?? "unclassified";
}

function stageStep(stage: V3Stage, key: string, parent: string | null, sequence: number, startedAt: string | null): StepDraft {
  const d = describeStep(stage.id);
  return {
    step_key: key, parent_key: parent, sequence, kind: STAGE_KIND[stage.id], name: stage.id, title: d.title, purpose: d.purpose,
    status: stage.status, started_at: startedAt, duration_ms: stage.durationMs, input: stage.input, output: stage.output ?? null,
    tool_name: stage.id === "search" ? "similarity_search" : null, model: stage.model ?? null,
    tokens_input: stage.usage?.input ?? null, tokens_output: stage.usage?.output ?? null, tokens_cached: stage.usage?.cached ?? null,
    cost_estimate_usd: usageCost(stage.model, stage.usage) ?? null, warnings: stage.warnings ?? [], error: stage.error ?? null,
    metadata: { config: stage.config ?? {}, counts: stage.counts ?? {}, filters: stage.filters ?? {} },
  };
}

export function mapV3Trace(input: V3MapperInput): TraceDraft {
  const t = input.trace;
  const parsedStart = Date.parse(t.startedAt);
  const startMs = Number.isFinite(parsedStart) ? parsedStart : Date.now();
  const startedAt = new Date(startMs).toISOString();
  const endedAt = new Date(startMs + t.totalMs).toISOString();
  const steps: StepDraft[] = [];
  const errors: ErrorDraft[] = [];
  let seq = 1;

  const req = describeStep("request-received");
  steps.push({ step_key: "request-received", sequence: seq++, kind: "request", name: "request-received", title: req.title,
    purpose: "The visitor's message reached the partner workflow.", status: "ok", started_at: startedAt, duration_ms: 0,
    input: { query: t.input.query, resume: t.input.resume ?? null }, output: null });

  let cursor = startMs;
  steps.push(stageStep(t.decompose, "decompose", null, seq++, startedAt));
  cursor += t.decompose.durationMs;
  if (t.decompose.error) errors.push({ step_key: "decompose", level: "error", type: classifyError(t.decompose.error.message), message: t.decompose.error.message });

  for (const run of t.tasks) {
    const key = `task:${run.task.id}`;
    const d = describeStep("task", { label: run.task.label });
    const status: StepStatus = run.status === "ok" ? "ok" : run.status === "needs_clarification" ? "warning" : "error";
    steps.push({ step_key: key, sequence: seq++, kind: "group", name: "task", title: d.title, purpose: d.purpose, status,
      started_at: new Date(cursor).toISOString(), duration_ms: run.totalMs, input: run.task,
      output: run.status === "needs_clarification" ? { clarification: run.clarification } : run.status === "ok" ? { answer: run.answer, recommendations: run.recommendations ?? [] } : null,
      error: run.error ?? null, warnings: run.status === "needs_clarification" ? [run.clarification ?? "needs clarification"] : [],
      tokens_input: run.usage?.input ?? null, tokens_output: run.usage?.output ?? null, tokens_cached: run.usage?.cached ?? null });
    if (run.error) errors.push({ step_key: key, level: "error", type: classifyError(run.error.message), message: run.error.message });
    if (run.status === "needs_clarification") errors.push({ step_key: key, level: "warning", type: "needs_clarification", message: run.clarification ?? "needs clarification" });
    let childCursor = cursor;
    run.stages.forEach((stage, i) => {
      const childKey = `${key}/${stage.id}`;
      steps.push(stageStep(stage, childKey, key, i + 1, stage.status === "skipped" ? null : new Date(childCursor).toISOString()));
      childCursor += stage.durationMs;
      if (stage.error) errors.push({ step_key: childKey, level: "error", type: classifyError(stage.error.message), message: stage.error.message });
      for (const w of stage.warnings ?? []) errors.push({ step_key: childKey, level: "warning", type: "stage_warning", message: w });
    });
  }

  const finalOutput = t.answer ?? t.clarification ?? "";
  const comp = describeStep("answer-composed");
  steps.push({ step_key: "answer-composed", sequence: seq++, kind: "response", name: "answer-composed", title: comp.title, purpose: comp.purpose,
    status: t.status === "failed" ? "error" : "ok", started_at: endedAt, duration_ms: 0,
    input: { tasks: t.tasks.map((r) => ({ id: r.task.id, label: r.task.label, status: r.status })), deferred: t.deferred.map((x) => x.label) },
    output: { answer: finalOutput } });
  if (t.status === "failed" && t.error && !errors.some((e) => e.message === t.error!.message)) {
    errors.push({ level: "error", type: classifyError(t.error.message), message: t.error.message });
  }

  const stageSteps = steps.filter((s) => s.kind !== "group");
  const totals = sumUsage(stageSteps);
  const models = [...new Set(stageSteps.map((s) => s.model).filter((m): m is string => Boolean(m)))];
  const status: TraceStatus = t.status === "ok" ? "completed" : t.status;
  const hasUsage = stageSteps.some((s) => s.tokens_input != null);
  return {
    session: { id: input.sessionId, agent: "partner", origin: input.origin ?? null },
    trace: {
      session_id: input.sessionId, agent: "partner", agent_version: input.agentVersion, turn_id: input.turnId, turn_index: input.turnIndex,
      status, started_at: startedAt, ended_at: endedAt, duration_ms: t.totalMs, first_token_ms: null,
      user_input: t.input.query, final_output: finalOutput, models,
      tools_called: steps.some((s) => s.tool_name === "similarity_search" && s.status !== "skipped") ? ["similarity_search"] : [],
      step_count: steps.length, tool_call_count: steps.filter((s) => s.kind === "tool" && s.status !== "skipped").length,
      error_count: errors.filter((e) => e.level === "error").length, warning_count: errors.filter((e) => e.level === "warning").length,
      tokens_input: hasUsage ? (t.usage?.input ?? totals.tokens_input) : null, tokens_output: hasUsage ? (t.usage?.output ?? totals.tokens_output) : null,
      tokens_cached: hasUsage ? (t.usage?.cached ?? totals.tokens_cached) : null, cost_estimate_usd: hasUsage ? totals.cost_estimate_usd : null,
      metadata: { run_id: t.runId, config: t.config, deferred: t.deferred, pending: t.pending, clarification: t.clarification ?? null, env: input.environment,
        ...(input.upstreamStatus ? { upstream_status: input.upstreamStatus } : {}) },
    },
    steps, errors,
  };
}

export function mapV3UpstreamError(input: Omit<V3MapperInput, "trace"> & { userInput: string; status: number; body: string; startedAt: string }): TraceDraft {
  const endedAt = new Date().toISOString();
  const message = `Partner agent returned HTTP ${input.status}: ${input.body.slice(0, 500)}`;
  const req = describeStep("request-received"); const fail = describeStep("failure");
  return {
    session: { id: input.sessionId, agent: "partner", origin: input.origin ?? null },
    trace: { session_id: input.sessionId, agent: "partner", agent_version: input.agentVersion, turn_id: input.turnId, turn_index: input.turnIndex,
      status: "failed", started_at: input.startedAt, ended_at: endedAt, user_input: input.userInput, final_output: "", models: [], tools_called: [],
      step_count: 2, tool_call_count: 0, error_count: 1, warning_count: 0, metadata: { env: input.environment, upstream_status: input.status } },
    steps: [
      { step_key: "request-received", sequence: 1, kind: "request", name: "request-received", title: req.title, purpose: "The visitor's message reached the partner workflow.", status: "ok", started_at: input.startedAt, duration_ms: 0, input: { query: input.userInput } },
      { step_key: "failure", sequence: 2, kind: "error", name: "failure", title: fail.title, purpose: fail.purpose, status: "error", started_at: endedAt, duration_ms: 0, error: { message, type: "upstream_unavailable" } },
    ],
    errors: [{ step_key: "failure", level: "error", type: "upstream_unavailable", message }],
    events: [{ type: "partner.upstream_error", session_id: input.sessionId, payload: { status: input.status, turn_id: input.turnId } }],
  };
}
```

- [ ] **Step 4: Run** the test — Expected: PASS. `npm run typecheck` — PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/monitoring/v3-mapper.ts tests/monitoring-v3-mapper.test.ts tests/fixtures/v3
git commit -m "monitoring: V3 WorkflowTrace → TraceDraft mapper with recorded fixtures"
```

---

### Task 7: Partner capture — widget ids, adapter observer, route wiring

**Files:**
- Modify: `lib/use-workflow-agent.ts` (send `sessionId`, `turnId`), `lib/partner-workflow.ts` (read + strip ids, `observe` dep), `app/api/partner/workflow/route.ts`
- Create: `lib/monitoring/partner-capture.ts`
- Test: `tests/partner-workflow.test.ts` (extend), `tests/monitoring-partner-capture.test.ts`

**Interfaces:**
- `lib/partner-workflow.ts`: `export interface WorkflowObservation { sessionId?: string; turnId?: string; message: string; origin: string | null; startedAt: string; status: number; body: string }`; `WorkflowForwardDeps.observe?: (r: WorkflowObservation) => Promise<void> | void`. `forwardToWorkflow` awaits `observe` inside try/catch after reading the upstream text and before returning the response.
- `lib/monitoring/partner-capture.ts`: `export async function captureWorkflow(o: WorkflowObservation, deps?: { store?: MonitoringStore; capMs?: number }): Promise<void>` — 2xx + parseable JSON with `runId` → `mapV3Trace`; otherwise `mapV3UpstreamError`; `store.writeTrace` raced against `capMs` (default 5000). Never throws. Missing ids ⇒ `wf_anon_<runId>` / `turn_0` and a shape-only warning.

- [ ] **Step 1: Failing tests** — append to `tests/partner-workflow.test.ts`:

```ts
describe("forwardToWorkflow — monitoring observer", () => {
  const req = (body: unknown) => new Request("http://widget.local/api/partner/workflow", { method: "POST", headers: { "content-type": "application/json", origin: "http://widget.local" }, body: JSON.stringify(body) });
  it("strips sessionId/turnId before forwarding and hands them to observe()", async () => {
    let forwarded: unknown; const seen: unknown[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => { forwarded = JSON.parse(String(init.body)); return new Response(JSON.stringify({ runId: "r1", status: "ok" }), { status: 200, headers: { "content-type": "application/json" } }); }) as unknown as typeof fetch;
    const res = await forwardToWorkflow(req({ message: "Yoga in Bochum", sessionId: "s1", turnId: "turn_3" }), { host: "http://127.0.0.1:3008", fetchImpl, observe: async (o) => { seen.push(o); } });
    expect(res.status).toBe(200);
    expect(forwarded).toEqual({ query: "Yoga in Bochum" });
    expect(seen[0]).toMatchObject({ sessionId: "s1", turnId: "turn_3", message: "Yoga in Bochum", status: 200, origin: "http://widget.local" });
    expect(JSON.parse((seen[0] as { body: string }).body)).toEqual({ runId: "r1", status: "ok" });
  });
  it("a throwing observer never changes the response", async () => {
    const fetchImpl = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const res = await forwardToWorkflow(req({ message: "x" }), { host: "http://127.0.0.1:3008", fetchImpl, observe: () => { throw new Error("db down"); } });
    expect(res.status).toBe(200);
  });
});
```
and `tests/monitoring-partner-capture.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { captureWorkflow } from "../lib/monitoring/partner-capture";
import { createStore } from "../lib/monitoring/store";

const ENV = { MONITORING_SUPABASE_URL: "https://x.supabase.co", MONITORING_SUPABASE_SERVICE_ROLE_KEY: "k" } as unknown as NodeJS.ProcessEnv;
const body = readFileSync(new URL("./fixtures/v3/single-task.json", import.meta.url), "utf8");
const obs = { sessionId: "s1", turnId: "turn_1", message: "Yoga in Bochum", origin: null, startedAt: new Date().toISOString(), status: 200, body };

describe("captureWorkflow", () => {
  it("writes a mapped trace", async () => {
    const rpc = vi.fn(async () => ({ data: "t", error: null }));
    await captureWorkflow(obs, { store: createStore({ client: { rpc }, env: ENV }) });
    const p = (rpc.mock.calls[0]![1] as { p: { trace: { agent: string; status: string } } }).p;
    expect(p.trace).toMatchObject({ agent: "partner", status: "completed" });
  });
  it("non-2xx → failed trace with partner.upstream_error event", async () => {
    const rpc = vi.fn(async () => ({ data: "t", error: null }));
    await captureWorkflow({ ...obs, status: 502, body: "Bad Gateway" }, { store: createStore({ client: { rpc }, env: ENV }) });
    const p = (rpc.mock.calls[0]![1] as { p: { trace: { status: string }; events: { type: string }[] } }).p;
    expect(p.trace.status).toBe("failed");
    expect(p.events[0]!.type).toBe("partner.upstream_error");
  });
  it("gives up after the cap without throwing", async () => {
    const rpc = vi.fn(() => new Promise(() => {}));
    await expect(captureWorkflow(obs, { store: createStore({ client: { rpc }, env: ENV }), capMs: 10 })).resolves.toBeUndefined();
  });
  it("disabled store ⇒ nothing happens", async () => {
    await expect(captureWorkflow(obs, { store: createStore({ env: {} as NodeJS.ProcessEnv }) })).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run both files** — Expected: FAIL.

- [ ] **Step 3: `lib/use-workflow-agent.ts`** — in `send`, before the fetch: `const turn = stateRef.current.turn + 1;` (read BEFORE `setState(applyUserMessage)`), then

```ts
body: JSON.stringify({ message, sessionId, turnId: `turn_${turn}`, ...(resume ? { resume } : {}) }),
```
and add `sessionId` to the `useCallback` dependency array: `[endpoint, sessionId]`.

- [ ] **Step 4: `lib/partner-workflow.ts`**

```ts
export interface WorkflowObservation { sessionId?: string; turnId?: string; message: string; origin: string | null; startedAt: string; status: number; body: string }
// in WorkflowForwardDeps:
  /** Monitoring observer; awaited but never allowed to affect the response. */
  observe?: (r: WorkflowObservation) => Promise<void> | void;
// body type:
let body: { message?: unknown; resume?: unknown; sessionId?: unknown; turnId?: unknown };
// after `message` validation:
const sessionId = typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim().slice(0, 200) : undefined;
const turnId = typeof body.turnId === "string" && /^turn_\d+$/.test(body.turnId) ? body.turnId : undefined;
const startedAt = new Date().toISOString();
// the forwarded body stays { query: message, ...(resume) } — ids are NOT forwarded
// after upstream:
const text = await upstream.text();
if (deps.observe) {
  try {
    await deps.observe({ sessionId, turnId, message, origin: req.headers.get("origin"), startedAt, status: upstream.status, body: text });
  } catch (e) {
    console.error("[partner-workflow] observer failed:", { error: e instanceof Error ? e.name : "unknown" });
  }
}
return new Response(text, { status: upstream.status, headers: { "Content-Type": upstream.headers.get("content-type") ?? "application/json" } });
```

- [ ] **Step 5: `lib/monitoring/partner-capture.ts`**

```ts
import type { WorkflowObservation } from "../partner-workflow";
import { agentVersion, monitoringEnvironment } from "./env";
import { store as defaultStore, type MonitoringStore } from "./store";
import { mapV3Trace, mapV3UpstreamError, type V3WorkflowTrace } from "./v3-mapper";

export async function captureWorkflow(o: WorkflowObservation, deps: { store?: MonitoringStore; capMs?: number } = {}): Promise<void> {
  const store = deps.store ?? defaultStore;
  if (!store.enabled) return;
  try {
    let parsed: V3WorkflowTrace | undefined;
    if (o.status >= 200 && o.status < 300) {
      try { parsed = JSON.parse(o.body) as V3WorkflowTrace; } catch { parsed = undefined; }
    }
    if (!o.sessionId || !o.turnId) console.warn("[monitoring] partner turn without ids", { hasSession: Boolean(o.sessionId), hasTurn: Boolean(o.turnId) });
    const sessionId = o.sessionId ?? `wf_anon_${parsed?.runId ?? Date.now()}`;
    const turnId = o.turnId ?? "turn_0";
    const common = { sessionId, turnId, turnIndex: Number(turnId.replace("turn_", "")) || undefined, origin: o.origin, agentVersion: agentVersion(), environment: monitoringEnvironment() };
    const draft = parsed && typeof parsed.runId === "string"
      ? mapV3Trace({ ...common, trace: parsed, upstreamStatus: o.status })
      : mapV3UpstreamError({ ...common, userInput: o.message, status: o.status, body: o.body, startedAt: o.startedAt });
    await Promise.race([store.writeTrace(draft), new Promise<void>((r) => setTimeout(r, deps.capMs ?? 5000))]);
  } catch (e) {
    console.error("[monitoring] partner capture failed:", { error: e instanceof Error ? e.name : "unknown" });
  }
}
```

- [ ] **Step 6: `app/api/partner/workflow/route.ts`** — `import { captureWorkflow } from "@/lib/monitoring/partner-capture";` and `return forwardToWorkflow(req, { observe: captureWorkflow });`.

- [ ] **Step 7: Run** `npm test` + `npm run typecheck` — PASS. Manual: with both dev servers running (widget 3001, V3 3008, `PARTNER_AGENT_HOST=http://127.0.0.1:3008`), send "Yoga in Bochum" from the partner screen; then `mcp__supabase-monitoring__execute_sql`: `select agent, status, step_count, user_input from traces order by started_at desc limit 1` — Expected: one `partner` row with `step_count` ≥ 9.

- [ ] **Step 8: Commit**

```bash
git add lib/use-workflow-agent.ts lib/partner-workflow.ts lib/monitoring/partner-capture.ts app/api/partner/workflow/route.ts tests/partner-workflow.test.ts tests/monitoring-partner-capture.test.ts
git commit -m "monitoring: capture V3 partner turns in the adapter (ids from the widget, stripped before forwarding)"
```

---

### Task 8: FAQ capture — `faq-mapper.ts` + `agent/hooks/monitoring.ts`

**Files:**
- Create: `lib/monitoring/faq-mapper.ts`, `agent/hooks/monitoring.ts`
- Test: `tests/monitoring-faq.test.ts`

**Design.** eve fires the hook events for one turn across several serverless invocations, so the hook keeps only a best-effort in-memory `FaqTurnState` per session and writes **incrementally**: every handler builds a partial `TraceDraft` (only the fields/steps it knows) and calls `store.writeTrace`; the RPC merges (Task 2). The `running` row is created on `message.received`. The hook file is a sibling of `agent/hooks/langfuse.ts`: eve loads every file in `agent/hooks/` (docs `guides/hooks.md`: "the slug is the path-relative basename"), and every handler is wrapped in the same `guard()` so it never throws.

**Interfaces (produced) — `faq-mapper.ts`:**
```ts
export interface FaqTurnState { sessionId: string; turnId?: string; startedAt?: number; question?: string; reply?: string; firstTokenAt?: number; stepStartedAt?: number; steps: number; usage: { input: number; output: number; cached: number }; tools: string[]; toolErrors: number }
export function freshFaqTurn(sessionId: string): FaqTurnState;
export interface FaqMapperEnv { agentVersion: string; environment: string; model: string; channel?: string; origin?: string | null }
export function faqRequestDraft(s: FaqTurnState, env: FaqMapperEnv, now: number): TraceDraft;       // message.received → running trace + request-received step
export function faqPromptDraft(s: FaqTurnState, prompt: string, env: FaqMapperEnv, now: number): TraceDraft; // load-knowledge-base step + prompt version
export function faqStepDraft(s: FaqTurnState, data: { usage?: unknown; finishReason?: string }, env: FaqMapperEnv, now: number): TraceDraft; // generate-answer
export function faqToolDraft(s: FaqTurnState, result: { toolName?: string; isError?: boolean; input?: unknown; output?: unknown }, env: FaqMapperEnv, now: number): TraceDraft;
export function faqCompletedDraft(s: FaqTurnState, env: FaqMapperEnv, now: number): TraceDraft;     // answer-delivered + totals, status completed
export function faqFailureDraft(s: FaqTurnState, kind: "step"|"turn"|"session", data: unknown, env: FaqMapperEnv, now: number): TraceDraft; // error step + errors row, status failed
export function readUsage(usage: unknown): { input: number; output: number; cached: number };      // same field fallbacks as lib/langfuse.ts usageTokens()
```
Every draft has `trace.session_id`, `trace.agent = "faq"`, `trace.turn_id` (`s.turnId ?? "turn_unknown"`), and `session` only on the request draft. Step keys = step names (`request-received`, `load-knowledge-base`, `generate-answer`, `tool:<name>:<n>`, `answer-delivered`, `failure`); sequences 1, 2, 3, 3.5→ tools use 4+, `answer-delivered` 9, `failure` 10 (ordering matters only within a trace).

- [ ] **Step 1: Write the failing tests** — `tests/monitoring-faq.test.ts`

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { faqRequestDraft, faqPromptDraft, faqStepDraft, faqCompletedDraft, faqFailureDraft, freshFaqTurn, readUsage } from "../lib/monitoring/faq-mapper";
import { monitoringHandlers } from "../agent/hooks/monitoring";
import { createStore } from "../lib/monitoring/store";
import { systemPromptStore } from "../lib/langfuse";

const env = { agentVersion: "abc", environment: "test", model: "gpt-4.1", channel: "http" };
const ctx = { agent: { name: "kb-agent" }, channel: { kind: "http" }, session: { id: "sess-mon" } };
const ENV = { MONITORING_SUPABASE_URL: "https://x.supabase.co", MONITORING_SUPABASE_SERVICE_ROLE_KEY: "k" } as unknown as NodeJS.ProcessEnv;

describe("faq mapper", () => {
  it("request draft: running trace, session, request-received step", () => {
    const s = { ...freshFaqTurn("s1"), turnId: "turn_2", question: "Was ist Firmenfitness?", startedAt: 1000 };
    const d = faqRequestDraft(s, env, 1000);
    expect(d.session).toMatchObject({ id: "s1", agent: "faq" });
    expect(d.trace).toMatchObject({ session_id: "s1", turn_id: "turn_2", turn_index: 2, status: "running", user_input: "Was ist Firmenfitness?", agent_version: "abc" });
    expect(d.steps[0]).toMatchObject({ step_key: "request-received", kind: "request", status: "ok", input: { message: "Was ist Firmenfitness?" } });
    expect(d.trace.metadata).toMatchObject({ env: "test", channel: "http" });
  });
  it("prompt draft: fingerprints the KB and attaches the prompt version", () => {
    const s = { ...freshFaqTurn("s1"), turnId: "turn_1" };
    const d = faqPromptDraft(s, "=== KNOWLEDGE BASE ===\nFAQ\n=== BEHAVIOR RULES ===\nx", env, 5);
    expect(d.prompt).toMatchObject({ agent: "faq", size_chars: 45, sections: ["KNOWLEDGE BASE", "BEHAVIOR RULES"] });
    expect(d.prompt!.sha256).toHaveLength(64);
    expect(d.steps[0]).toMatchObject({ step_key: "load-knowledge-base", kind: "transform", status: "ok" });
    expect(d.steps[0]!.purpose).toContain(d.prompt!.sha256.slice(0, 12));
    expect(d.steps[0]!.metadata).toMatchObject({ prompt_sha256: d.prompt!.sha256 });
  });
  it("step draft: generate-answer with model, usage, duration and cost", () => {
    const s = { ...freshFaqTurn("s1"), turnId: "turn_1", stepStartedAt: 1000, question: "q" };
    const d = faqStepDraft(s, { usage: { inputTokens: 17000, outputTokens: 200, inputTokenDetails: { cacheReadTokens: 16000 } }, finishReason: "stop" }, env, 3500);
    expect(d.steps[0]).toMatchObject({ step_key: "generate-answer", kind: "llm", model: "gpt-4.1", tokens_input: 17000, tokens_output: 200, tokens_cached: 16000, duration_ms: 2500 });
    expect(d.steps[0]!.cost_estimate_usd).toBeGreaterThan(0);
    expect(s.usage).toEqual({ input: 17000, output: 200, cached: 16000 });
    expect(s.steps).toBe(1);
  });
  it("completed draft: totals, first token, answer-delivered", () => {
    const s = { ...freshFaqTurn("s1"), turnId: "turn_1", startedAt: 1000, firstTokenAt: 1400, question: "q", reply: "Antwort", steps: 1, usage: { input: 100, output: 10, cached: 0 } };
    const d = faqCompletedDraft(s, env, 2000);
    expect(d.trace).toMatchObject({ status: "completed", final_output: "Antwort", duration_ms: 1000, first_token_ms: 400, tokens_input: 100, tokens_output: 10, models: ["gpt-4.1"], step_count: 4 });
    expect(d.steps[0]).toMatchObject({ step_key: "answer-delivered", kind: "response", output: { answer: "Antwort" } });
  });
  it("failure draft: classified error step + errors row + failed status", () => {
    const s = { ...freshFaqTurn("s1"), turnId: "turn_1", startedAt: 1000, question: "q" };
    const d = faqFailureDraft(s, "turn", { code: "turn_error", message: "429 too many requests" }, env, 1500);
    expect(d.trace.status).toBe("failed");
    expect(d.steps[0]).toMatchObject({ step_key: "failure", kind: "error", status: "error" });
    expect(d.errors[0]).toMatchObject({ level: "error", type: "upstream_unavailable", message: "429 too many requests" });
    expect(d.trace.error_count).toBe(1);
  });
  it("readUsage accepts the AI SDK and OpenAI spellings", () => {
    expect(readUsage({ promptTokens: 5, completionTokens: 2, promptTokensDetails: { cachedTokens: 1 } })).toEqual({ input: 5, output: 2, cached: 1 });
    expect(readUsage(undefined)).toEqual({ input: 0, output: 0, cached: 0 });
  });
});

describe("monitoring hook", () => {
  beforeEach(() => systemPromptStore.delete(ctx.session.id));
  const setup = () => {
    const calls: { p: { trace: Record<string, unknown>; steps: { step_key: string }[]; prompt?: unknown } }[] = [];
    const rpc = vi.fn(async (_fn: string, args: Record<string, unknown>) => { calls.push(args as (typeof calls)[number]); return { data: "t", error: null }; });
    const store = createStore({ client: { rpc }, env: ENV });
    let t = 1000;
    const handlers = monitoringHandlers({ store, now: () => (t += 100), env });
    return { calls, handlers };
  };
  it("writes a running row, then the KB, the model step, then completion", async () => {
    const { calls, handlers } = setup();
    systemPromptStore.set(ctx.session.id, "=== KNOWLEDGE BASE ===\nFAQ");
    await handlers["message.received"]!({ data: { message: "Wie checke ich ein?", turnId: "turn_1" } }, ctx);
    await handlers["step.started"]!({ data: {} }, ctx);
    await handlers["step.completed"]!({ data: { usage: { inputTokens: 10, outputTokens: 2 } } }, ctx);
    await handlers["message.appended"]!({ data: { delta: "S" } }, ctx);
    await handlers["message.completed"]!({ data: { text: "Scanne den QR-Code" } }, ctx);
    await handlers["turn.completed"]!({ data: { turnId: "turn_1" } }, ctx);
    expect(calls.map((c) => c.p.steps.map((s) => s.step_key))).toEqual([["request-received"], ["load-knowledge-base", "generate-answer"], ["answer-delivered"]]);
    expect(calls[0]!.p.trace.status).toBe("running");
    expect(calls[1]!.p.prompt).toBeDefined();
    expect(calls[2]!.p.trace).toMatchObject({ status: "completed", final_output: "Scanne den QR-Code", turn_id: "turn_1" });
  });
  it("a failed turn writes the failure and marks the trace failed", async () => {
    const { calls, handlers } = setup();
    await handlers["message.received"]!({ data: { message: "hi", turnId: "turn_1" } }, ctx);
    await handlers["turn.failed"]!({ data: { code: "turn_error", message: "boom" } }, ctx);
    expect(calls.at(-1)!.p.trace.status).toBe("failed");
    expect(calls.at(-1)!.p.steps[0]!.step_key).toBe("failure");
  });
  it("never throws, even when the store client explodes", async () => {
    const store = createStore({ client: { rpc: async () => { throw new Error("x"); } }, env: ENV, log: () => {} });
    const handlers = monitoringHandlers({ store, env });
    await expect(handlers["message.received"]!({ data: { message: "hi" } }, ctx)).resolves.toBeUndefined();
    await expect(handlers["turn.completed"]!({ data: {} }, ctx)).resolves.toBeUndefined();
  });
  it("is inert without credentials", async () => {
    const rpc = vi.fn();
    const handlers = monitoringHandlers({ store: createStore({ env: {} as NodeJS.ProcessEnv }), env });
    await handlers["message.received"]!({ data: { message: "hi" } }, ctx);
    expect(rpc).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run** `npx vitest run tests/monitoring-faq.test.ts` — FAIL.

- [ ] **Step 3: Write `lib/monitoring/faq-mapper.ts`**

```ts
// Pure: eve hook events → partial TraceDrafts for the FAQ agent. Each function
// returns ONLY what that event knows; the RPC merges. Mirrors the journal in
// lib/langfuse.ts but writes rows instead of spans.
import { createHash } from "node:crypto";
import { FAILURE_PATTERNS, failureMessage } from "../langfuse";
import { describeStep } from "./describe";
import { usageCost } from "./pricing";
import type { StepDraft, TraceDraft } from "./types";

export interface FaqTurnState {
  sessionId: string; turnId?: string; startedAt?: number; question?: string; reply?: string; firstTokenAt?: number; stepStartedAt?: number;
  steps: number; usage: { input: number; output: number; cached: number }; tools: string[]; toolErrors: number;
}
export function freshFaqTurn(sessionId: string): FaqTurnState {
  return { sessionId, steps: 0, usage: { input: 0, output: 0, cached: 0 }, tools: [], toolErrors: 0 };
}
export interface FaqMapperEnv { agentVersion: string; environment: string; model: string; channel?: string; origin?: string | null }

export function readUsage(usage: unknown): { input: number; output: number; cached: number } {
  const u = (usage ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const inDetails = u.inputTokenDetails as Record<string, unknown> | undefined;
  const promptDetails = u.promptTokensDetails as Record<string, unknown> | undefined;
  return {
    input: n(u.inputTokens) || n(u.promptTokens) || n(u.input_tokens),
    output: n(u.outputTokens) || n(u.completionTokens) || n(u.output_tokens),
    cached: n(inDetails?.cacheReadTokens) || n(u.cachedInputTokens) || n(u.cacheReadInputTokens) || n(u.cached_tokens) || n(promptDetails?.cachedTokens),
  };
}

const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());
const turnIndex = (turnId: string | undefined) => (turnId ? Number(turnId.replace("turn_", "")) || undefined : undefined);
function base(s: FaqTurnState, env: FaqMapperEnv): TraceDraft["trace"] {
  return { session_id: s.sessionId, agent: "faq", turn_id: s.turnId ?? "turn_unknown", turn_index: turnIndex(s.turnId), agent_version: env.agentVersion,
    metadata: { env: env.environment, channel: env.channel ?? "unknown" } };
}
function step(name: string, sequence: number, kind: StepDraft["kind"], extra: Partial<StepDraft> = {}, describeExtra?: { digest?: string }): StepDraft {
  const d = describeStep(name, describeExtra);
  return { step_key: name, sequence, kind, name, title: d.title, purpose: d.purpose, status: "ok", ...extra };
}

export function faqRequestDraft(s: FaqTurnState, env: FaqMapperEnv, now: number): TraceDraft {
  const startedAt = iso(s.startedAt ?? now)!;
  return {
    session: { id: s.sessionId, agent: "faq", origin: env.origin ?? null },
    trace: { ...base(s, env), status: "running", started_at: startedAt, user_input: s.question ?? "", models: [env.model], tools_called: [] },
    steps: [step("request-received", 1, "request", { started_at: startedAt, duration_ms: 0, input: { message: s.question ?? "" } })],
    errors: [],
  };
}

export function faqPromptDraft(s: FaqTurnState, prompt: string, env: FaqMapperEnv, now: number): TraceDraft {
  const sha256 = createHash("sha256").update(prompt).digest("hex");
  const sections = [...prompt.matchAll(/^===\s*(.+?)\s*===$/gm)].map((m) => m[1]!);
  return {
    trace: base(s, env),
    prompt: { agent: "faq", sha256, size_chars: prompt.length, approx_tokens: Math.round(prompt.length / 4), sections, content: prompt },
    steps: [step("load-knowledge-base", 2, "transform", { started_at: iso(s.startedAt ?? now), duration_ms: 0,
      input: { source: "agent/instructions.md", size_chars: prompt.length, sections }, output: { retrieved: "nothing — the KB is already in the prompt" },
      metadata: { prompt_sha256: sha256, approx_tokens: Math.round(prompt.length / 4) } }, { digest: sha256.slice(0, 12) })],
    errors: [],
  };
}

export function faqStepDraft(s: FaqTurnState, data: { usage?: unknown; finishReason?: string }, env: FaqMapperEnv, now: number): TraceDraft {
  const u = readUsage(data.usage);
  s.steps += 1; s.usage.input += u.input; s.usage.output += u.output; s.usage.cached += u.cached;
  const started = s.stepStartedAt ?? s.startedAt;
  const key = s.steps === 1 ? "generate-answer" : `generate-answer:${s.steps}`;
  return {
    trace: base(s, env),
    steps: [{ ...step("generate-answer", 2 + s.steps, "llm", { started_at: iso(started), duration_ms: started === undefined ? null : now - started, model: env.model,
      tokens_input: u.input, tokens_output: u.output, tokens_cached: u.cached, cost_estimate_usd: usageCost(env.model, u) ?? null,
      input: { question: s.question ?? "", knowledge: "system prompt (see load-knowledge-base)" }, output: { finish_reason: data.finishReason ?? "unknown" } }), step_key: key }],
    errors: [],
  };
}

export function faqToolDraft(s: FaqTurnState, result: { toolName?: string; isError?: boolean; input?: unknown; output?: unknown }, env: FaqMapperEnv, now: number): TraceDraft {
  const name = result.toolName ?? "unknown_tool";
  s.tools.push(name); if (result.isError) s.toolErrors += 1;
  const key = `tool:${name}:${s.tools.length}`;
  return {
    trace: { ...base(s, env), tools_called: [...new Set(s.tools)], tool_call_count: s.tools.length },
    steps: [{ ...step("tool", 3 + s.tools.length, "tool", { started_at: iso(now), duration_ms: null, tool_name: name, status: result.isError ? "error" : "ok",
      input: result.input ?? null, output: result.output ?? null, error: result.isError ? { message: String(result.output ?? "tool error") } : null }), step_key: key, title: `Tool call — ${name}` }],
    errors: result.isError ? [{ step_key: key, level: "error", type: "tool_error", message: String(result.output ?? "tool error") }] : [],
  };
}

export function faqCompletedDraft(s: FaqTurnState, env: FaqMapperEnv, now: number): TraceDraft {
  const start = s.startedAt ?? now;
  const cost = usageCost(env.model, s.usage);
  return {
    trace: { ...base(s, env), status: "completed", ended_at: iso(now), duration_ms: now - start, first_token_ms: s.firstTokenAt !== undefined ? s.firstTokenAt - start : null,
      final_output: s.reply ?? "", models: [env.model], tools_called: [...new Set(s.tools)], step_count: 3 + s.tools.length + 1, tool_call_count: s.tools.length,
      error_count: s.toolErrors, tokens_input: s.usage.input, tokens_output: s.usage.output, tokens_cached: s.usage.cached, cost_estimate_usd: cost ?? null },
    steps: [step("answer-delivered", 9, "response", { started_at: iso(now), duration_ms: 0, output: { answer: s.reply ?? "" } })],
    errors: [],
  };
}

export function faqFailureDraft(s: FaqTurnState, kind: "step" | "turn" | "session", data: unknown, env: FaqMapperEnv, now: number): TraceDraft {
  const { message, code } = failureMessage(data, `eve ${kind} failed`);
  const type = FAILURE_PATTERNS.find((p) => p.match.test(message))?.error_type ?? "unclassified";
  const start = s.startedAt ?? now;
  return {
    trace: { ...base(s, env), status: "failed", ended_at: iso(now), duration_ms: now - start, final_output: s.reply ?? "", error_count: 1,
      tokens_input: s.usage.input, tokens_output: s.usage.output, tokens_cached: s.usage.cached, metadata: { env: env.environment, channel: env.channel ?? "unknown", failure_kind: kind, failure_code: code ?? null } },
    steps: [step("failure", 10, "error", { status: "error", started_at: iso(now), duration_ms: 0, input: { question: s.question ?? "" }, error: { message, type }, metadata: { kind, code: code ?? null } })],
    errors: [{ step_key: "failure", level: "error", type, message, metadata: { kind, code: code ?? null } }],
  };
}
```

- [ ] **Step 4: Write `agent/hooks/monitoring.ts`**

```ts
// FAQ turn → Supabase monitoring. Sibling of ./langfuse.ts; same iron rule:
// never throw. Writes INCREMENTALLY because a turn spans several serverless
// invocations — the `running` row exists from message.received on, and the
// RPC merges each later fragment (lib/monitoring/faq-mapper.ts).
import { defineHook } from "eve/hooks";
import { appMetadata, systemPromptStore } from "../../lib/langfuse.ts";
import { agentVersion, monitoringEnvironment } from "../../lib/monitoring/env.ts";
import {
  faqCompletedDraft, faqFailureDraft, faqPromptDraft, faqRequestDraft, faqStepDraft, faqToolDraft, freshFaqTurn,
  type FaqMapperEnv, type FaqTurnState,
} from "../../lib/monitoring/faq-mapper.ts";
import { store as defaultStore, type MonitoringStore } from "../../lib/monitoring/store.ts";

type HookHandler = (event: { data?: Record<string, unknown> }, ctx: HookCtx) => Promise<void>;
interface HookCtx { agent: { name: string }; channel?: { kind?: string }; session: { id: string } }

const guard = (fn: HookHandler): HookHandler => async (event, ctx) => { try { await fn(event, ctx); } catch { /* monitoring never breaks the agent */ } };

export function monitoringHandlers(opts: { store?: MonitoringStore; now?: () => number; env?: Partial<FaqMapperEnv> } = {}): Record<string, HookHandler> {
  const store = opts.store ?? defaultStore;
  const now = opts.now ?? Date.now;
  const turns = new Map<string, FaqTurnState>();
  const state = (id: string) => { let s = turns.get(id); if (!s) { s = freshFaqTurn(id); turns.set(id, s); } return s; };
  const envFor = (ctx: HookCtx): FaqMapperEnv => ({
    agentVersion: opts.env?.agentVersion ?? agentVersion(), environment: opts.env?.environment ?? monitoringEnvironment(),
    model: opts.env?.model ?? appMetadata()["app.model"] ?? "unknown", channel: opts.env?.channel ?? ctx.channel?.kind, origin: opts.env?.origin ?? null,
  });
  const write = (d: ReturnType<typeof faqRequestDraft>) => store.writeTrace(d);

  return {
    "message.received": guard(async (event, ctx) => {
      if (!store.enabled) return;
      const s = freshFaqTurn(ctx.session.id);
      s.startedAt = now();
      s.question = typeof event.data?.message === "string" ? event.data.message : undefined;
      if (typeof event.data?.turnId === "string" && event.data.turnId) s.turnId = event.data.turnId;
      turns.set(ctx.session.id, s);
      await write(faqRequestDraft(s, envFor(ctx), s.startedAt));
    }),
    "step.started": guard(async (_event, ctx) => {
      if (!store.enabled) return;
      state(ctx.session.id).stepStartedAt = now();
    }),
    "step.completed": guard(async (event, ctx) => {
      if (!store.enabled) return;
      const s = state(ctx.session.id); const env = envFor(ctx); const at = now();
      const prompt = systemPromptStore.get(ctx.session.id);
      const stepDraft = faqStepDraft(s, { usage: event.data?.usage, finishReason: typeof event.data?.finishReason === "string" ? event.data.finishReason : undefined }, env, at);
      if (prompt && s.steps === 1) {
        const p = faqPromptDraft(s, prompt, env, at);
        await write({ ...p, steps: [...p.steps, ...stepDraft.steps] });
      } else {
        await write(stepDraft);
      }
    }),
    "message.appended": guard(async (_event, ctx) => {
      const s = state(ctx.session.id);
      if (s.firstTokenAt === undefined) s.firstTokenAt = now();
    }),
    "message.completed": guard(async (event, ctx) => {
      const text = (event.data?.text ?? event.data?.message ?? event.data?.content) as unknown;
      if (typeof text === "string" && text.trim() !== "") state(ctx.session.id).reply = text;
    }),
    "action.result": guard(async (event, ctx) => {
      if (!store.enabled) return;
      const result = event.data?.result as { toolName?: string; isError?: boolean; input?: unknown; output?: unknown } | undefined;
      if (!result) return;
      await write(faqToolDraft(state(ctx.session.id), result, envFor(ctx), now()));
    }),
    "turn.completed": guard(async (event, ctx) => {
      if (!store.enabled) return;
      const s = state(ctx.session.id);
      if (typeof event.data?.turnId === "string" && event.data.turnId) s.turnId = event.data.turnId;
      await write(faqCompletedDraft(s, envFor(ctx), now()));
      turns.delete(ctx.session.id);
    }),
    "step.failed": guard(async (event, ctx) => {
      if (!store.enabled) return;
      await write(faqFailureDraft(state(ctx.session.id), "step", event.data, envFor(ctx), now()));
    }),
    "turn.failed": guard(async (event, ctx) => {
      if (!store.enabled) return;
      await write(faqFailureDraft(state(ctx.session.id), "turn", event.data, envFor(ctx), now()));
      turns.delete(ctx.session.id);
    }),
    "session.failed": guard(async (event, ctx) => {
      if (!store.enabled) return;
      await write(faqFailureDraft(state(ctx.session.id), "session", event.data, envFor(ctx), now()));
      turns.delete(ctx.session.id);
    }),
  };
}

export default defineHook({ events: monitoringHandlers() as never });
```

Note on `turn_id` when the hook runs on a cold instance: `message.received` always carries `turnId` (verified: the Langfuse hook reads it the same way). If a later fragment arrives on another instance with an empty `FaqTurnState`, its `turn_id` falls back to `turn_unknown` and the RPC creates a second row. **Mitigation (do it):** persist `turnId` + `startedAt` per session with the same `fileStore` pattern as `lib/langfuse.ts` — export from `faq-mapper.ts`:

```ts
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
const DIR = process.env.VERCEL ? "/tmp/navio-monitoring/turns" : ".data/monitoring/turns";
export const turnStateStore = {
  set(s: FaqTurnState) { try { mkdirSync(DIR, { recursive: true }); writeFileSync(`${DIR}/${encodeURIComponent(s.sessionId)}.json`, JSON.stringify(s)); } catch { /* best-effort */ } },
  get(sessionId: string): FaqTurnState | undefined { try { return JSON.parse(readFileSync(`${DIR}/${encodeURIComponent(sessionId)}.json`, "utf8")) as FaqTurnState; } catch { return undefined; } },
  delete(sessionId: string) { try { unlinkSync(`${DIR}/${encodeURIComponent(sessionId)}.json`); } catch { /* best-effort */ } },
};
```
and in the hook: `state()` falls back to `turnStateStore.get(id)` before `freshFaqTurn`; `message.received`, `step.completed`, `message.completed` call `turnStateStore.set(s)` after mutating; `turn.completed`/`turn.failed`/`session.failed` call `turnStateStore.delete(id)`.

- [ ] **Step 5: Run** the test file, then `npm test` and `npm run typecheck` — PASS. Confirm `.data/` is gitignored (it is: root `.gitignore` has `.data/`).

- [ ] **Step 6: Live check.** `npm run dev:ui -- -p 3001`; ask "Was ist Firmenfitness?" on the FAQ screen; then `execute_sql`: `select status, step_count, tokens_input, cost_estimate_usd, prompt_version_id is not null as has_prompt from traces where agent='faq' order by started_at desc limit 1` → `completed`, `4`, > 0, > 0, `true`. And `select name, sequence, status from trace_steps where trace_id = (select id from traces where agent='faq' order by started_at desc limit 1) order by sequence` → request-received, load-knowledge-base, generate-answer, answer-delivered. Also run `npm run langfuse:verify <session>` to confirm Langfuse is unchanged.

- [ ] **Step 7: Commit**

```bash
git add lib/monitoring/faq-mapper.ts agent/hooks/monitoring.ts tests/monitoring-faq.test.ts
git commit -m "monitoring: FAQ hook writes step-by-step traces incrementally (running → KB → model → delivered/failed)"
```

---

### Task 9: Feedback persistence in `/api/feedback`

**Files:**
- Create: `lib/monitoring/feedback.ts`
- Modify: `app/api/feedback/route.ts`
- Test: `tests/monitoring-feedback.test.ts`

**Interfaces (produced):**
```ts
export async function recordFeedback(parsed: FeedbackRequest, deps?: { store?: MonitoringStore; agentVersion?: string }): Promise<{ linked: boolean; traceId?: string } | undefined>; // never throws
export async function noteEvent(type: string, payload: Record<string, unknown>, sessionId?: string, deps?: { store?: MonitoringStore }): Promise<void>;
```

- [ ] **Step 1: Failing tests**

```ts
import { describe, it, expect, vi } from "vitest";
import { recordFeedback, noteEvent } from "../lib/monitoring/feedback";
import { createStore } from "../lib/monitoring/store";

const ENV = { MONITORING_SUPABASE_URL: "https://x.supabase.co", MONITORING_SUPABASE_SERVICE_ROLE_KEY: "k" } as unknown as NodeJS.ProcessEnv;
const vote = { sessionId: "s1", turnId: "turn_1", thumb: "down" as const, epoch: 0, reason: "wrong_info", comment: "nein", surface: "partner" as const };

describe("recordFeedback", () => {
  it("maps the request to a FeedbackDraft and reports linkage", async () => {
    const rpc = vi.fn(async () => ({ data: { trace_id: "t1", linked: true }, error: null }));
    const r = await recordFeedback(vote, { store: createStore({ client: { rpc }, env: ENV }), agentVersion: "abc" });
    expect(r).toEqual({ linked: true, traceId: "t1" });
    expect(rpc.mock.calls[0]![1]).toMatchObject({ p: { session_id: "s1", turn_id: "turn_1", agent: "partner", thumb: "down", reason: "wrong_info", comment: "nein", epoch: 0, agent_version: "abc" } });
  });
  it("unlinked vote (trace not yet written) is reported as linked:false", async () => {
    const rpc = vi.fn(async () => ({ data: { trace_id: null, linked: false }, error: null }));
    expect(await recordFeedback(vote, { store: createStore({ client: { rpc }, env: ENV }) })).toEqual({ linked: false, traceId: undefined });
  });
  it("retraction stores thumb null", async () => {
    const rpc = vi.fn(async () => ({ data: { trace_id: "t1", linked: true }, error: null }));
    await recordFeedback({ ...vote, thumb: null, reason: null, comment: null }, { store: createStore({ client: { rpc }, env: ENV }) });
    expect((rpc.mock.calls[0]![1] as { p: { thumb: unknown } }).p.thumb).toBeNull();
  });
  it("never throws and is inert without creds", async () => {
    await expect(recordFeedback(vote, { store: createStore({ client: { rpc: async () => { throw new Error("x"); } }, env: ENV, log: () => {} }) })).resolves.toBeUndefined();
    await expect(recordFeedback(vote, { store: createStore({ env: {} as NodeJS.ProcessEnv }) })).resolves.toBeUndefined();
    await expect(noteEvent("feedback.partner_forward_failed", { status: 502 }, "s1", { store: createStore({ env: {} as NodeJS.ProcessEnv }) })).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Write `lib/monitoring/feedback.ts`**

```ts
import type { FeedbackRequest } from "../feedback";
import { agentVersion as readAgentVersion } from "./env";
import { store as defaultStore, type MonitoringStore } from "./store";

export async function recordFeedback(parsed: FeedbackRequest, deps: { store?: MonitoringStore; agentVersion?: string } = {}): Promise<{ linked: boolean; traceId?: string } | undefined> {
  const store = deps.store ?? defaultStore;
  if (!store.enabled) return undefined;
  try {
    const r = await store.recordFeedback({
      session_id: parsed.sessionId, turn_id: parsed.turnId, agent: parsed.surface === "partner" ? "partner" : "faq", thumb: parsed.thumb,
      reason: parsed.reason ?? null, comment: parsed.comment ?? null, epoch: parsed.epoch ?? 0, agent_version: deps.agentVersion ?? readAgentVersion(),
    });
    return r ? { linked: r.linked, traceId: r.traceId } : undefined;
  } catch (e) {
    console.error("[monitoring] recordFeedback failed:", { error: e instanceof Error ? e.name : "unknown" });
    return undefined;
  }
}

/** The monitoring system's own log line (events table); flushed with the next trace write. */
export async function noteEvent(type: string, payload: Record<string, unknown>, sessionId?: string, deps: { store?: MonitoringStore } = {}): Promise<void> {
  const store = deps.store ?? defaultStore;
  if (!store.enabled) return;
  try { await store.logEvent({ type, session_id: sessionId, payload }); } catch { /* never */ }
}
```

- [ ] **Step 4: `app/api/feedback/route.ts`** — after the rate-limit check and before the `surface === "partner"` branch:

```ts
  // Supabase monitoring (both surfaces) — additive, never throws, never changes the response.
  const monitored = await recordFeedback(parsed);
  if (monitored) console.info("MONITORING feedback:", { linked: monitored.linked, surface: parsed.surface ?? "faq" });
```
and inside `forwardToPartner`'s two failure paths add `await noteEvent("feedback.partner_forward_failed", { status: res.status }, sessionId)` / `{ detail: "fetch" }` — change its signature to `forwardToPartner(body: FeedbackRequest)` so it has `body.sessionId`. Imports: `import { noteEvent, recordFeedback } from "@/lib/monitoring/feedback";`.

- [ ] **Step 5: Run** `npm test`, `npm run typecheck` — PASS. Live: vote 👍 on the FAQ answer from Task 8's live check; `select thumb, trace_id is not null as linked from feedback order by created_at desc limit 1` → `up`, `true`; `select feedback_thumb from traces where agent='faq' order by started_at desc limit 1` → `up`.

- [ ] **Step 6: Commit**

```bash
git add lib/monitoring/feedback.ts app/api/feedback/route.ts tests/monitoring-feedback.test.ts
git commit -m "monitoring: persist every vote (both surfaces) against its trace; partner V3 votes recorded for the first time"
```

---

### Task 10: Dashboard auth — cookie signing, login route, middleware

**Files:**
- Create: `lib/monitoring/auth.ts`, `middleware.ts` (project root), `app/api/monitoring/auth/route.ts`, `app/monitoring/login/page.tsx`
- Test: `tests/monitoring-auth.test.ts`

**Interfaces (produced) — `lib/monitoring/auth.ts` (Web Crypto only, so it also runs in the middleware's edge runtime):**
```ts
export const COOKIE_NAME = "navio_monitoring";
export const COOKIE_MAX_AGE_SEC = 7 * 24 * 3600;
export async function signSession(secret: string, expiresAtSec: number): Promise<string>;      // `${exp}.${hex hmac-sha256(secret, String(exp))}`
export async function verifySession(secret: string, token: string | undefined, nowSec?: number): Promise<boolean>;
export async function passwordMatches(expected: string, given: string): Promise<boolean>;      // constant-time via HMAC compare
export function createLoginThrottle(opts?: { max?: number; windowMs?: number; now?: () => number }): { check(ip: string): boolean; fail(ip: string): void };  // max 5 / 15 min
export function cookieHeader(token: string, secure: boolean): string;  // `navio_monitoring=<t>; Path=/; HttpOnly; SameSite=Lax; Max-Age=…[; Secure]`
export function isProtectedPath(pathname: string): boolean;  // /monitoring/* except /monitoring/login, and /api/monitoring/(traces|stats|sessions)*
```

- [ ] **Step 1: Failing tests**

```ts
import { describe, it, expect } from "vitest";
import { signSession, verifySession, passwordMatches, createLoginThrottle, cookieHeader, isProtectedPath } from "../lib/monitoring/auth";

describe("monitoring auth", () => {
  const secret = "s".repeat(32);
  it("signs and verifies a session; tampering or expiry fails", async () => {
    const exp = 2_000_000_000;
    const t = await signSession(secret, exp);
    expect(t.startsWith(`${exp}.`)).toBe(true);
    expect(await verifySession(secret, t, exp - 10)).toBe(true);
    expect(await verifySession(secret, t, exp + 1)).toBe(false);
    expect(await verifySession(secret, `${exp}.` + "0".repeat(64), exp - 10)).toBe(false);
    expect(await verifySession("other", t, exp - 10)).toBe(false);
    expect(await verifySession(secret, undefined)).toBe(false);
    expect(await verifySession(secret, "garbage")).toBe(false);
  });
  it("password compare", async () => {
    expect(await passwordMatches("hunter2", "hunter2")).toBe(true);
    expect(await passwordMatches("hunter2", "hunter3")).toBe(false);
    expect(await passwordMatches("hunter2", "")).toBe(false);
  });
  it("throttle: 5 failures per 15 minutes per ip", () => {
    let now = 0;
    const th = createLoginThrottle({ now: () => now });
    for (let i = 0; i < 5; i++) { expect(th.check("1.1.1.1")).toBe(true); th.fail("1.1.1.1"); }
    expect(th.check("1.1.1.1")).toBe(false);
    expect(th.check("2.2.2.2")).toBe(true);
    now = 15 * 60_000 + 1;
    expect(th.check("1.1.1.1")).toBe(true);
  });
  it("cookie header and protected paths", () => {
    expect(cookieHeader("abc", true)).toBe("navio_monitoring=abc; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800; Secure");
    expect(cookieHeader("abc", false)).not.toContain("Secure");
    expect(isProtectedPath("/monitoring")).toBe(true);
    expect(isProtectedPath("/monitoring/traces/x")).toBe(true);
    expect(isProtectedPath("/monitoring/login")).toBe(false);
    expect(isProtectedPath("/api/monitoring/traces")).toBe(true);
    expect(isProtectedPath("/api/monitoring/stats")).toBe(true);
    expect(isProtectedPath("/api/monitoring/sessions/s1")).toBe(true);
    expect(isProtectedPath("/api/monitoring/alerts/faq")).toBe(false);
    expect(isProtectedPath("/api/monitoring/auth")).toBe(false);
  });
});
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Write `lib/monitoring/auth.ts`**

```ts
// Shared-password dashboard auth. Web Crypto only: this module is imported by
// middleware.ts (edge runtime) as well as the node route handlers.
export const COOKIE_NAME = "navio_monitoring";
export const COOKIE_MAX_AGE_SEC = 7 * 24 * 3600;

const enc = new TextEncoder();
async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function equalHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signSession(secret: string, expiresAtSec: number): Promise<string> {
  return `${expiresAtSec}.${await hmacHex(secret, String(expiresAtSec))}`;
}
export async function verifySession(secret: string, token: string | undefined, nowSec: number = Math.floor(Date.now() / 1000)): Promise<boolean> {
  if (!secret || !token) return false;
  const [expStr, sig] = token.split(".");
  if (!expStr || !sig || !/^\d+$/.test(expStr)) return false;
  if (Number(expStr) <= nowSec) return false;
  return equalHex(await hmacHex(secret, expStr), sig);
}
/** Constant-time compare by hashing both sides with the same random key. */
export async function passwordMatches(expected: string, given: string): Promise<boolean> {
  if (!expected || !given) return false;
  const k = "navio-monitoring-password-compare";
  return equalHex(await hmacHex(k, expected), await hmacHex(k, given));
}
export function createLoginThrottle(opts: { max?: number; windowMs?: number; now?: () => number } = {}) {
  const max = opts.max ?? 5, windowMs = opts.windowMs ?? 15 * 60_000, now = opts.now ?? Date.now;
  const fails = new Map<string, { count: number; resetAt: number }>();
  return {
    check(ip: string): boolean { const e = fails.get(ip); if (!e || now() > e.resetAt) return true; return e.count < max; },
    fail(ip: string): void { const e = fails.get(ip); if (!e || now() > e.resetAt) fails.set(ip, { count: 1, resetAt: now() + windowMs }); else e.count += 1; },
  };
}
export function cookieHeader(token: string, secure: boolean): string {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_SEC}${secure ? "; Secure" : ""}`;
}
export function isProtectedPath(pathname: string): boolean {
  if (pathname === "/monitoring/login") return false;
  if (pathname === "/monitoring" || pathname.startsWith("/monitoring/")) return true;
  return /^\/api\/monitoring\/(traces|stats|sessions)(\/|$)/.test(pathname);
}
```

- [ ] **Step 4: `middleware.ts`** (project root, next to `next.config.mjs`)

```ts
// Guards the monitoring dashboard + its data API. Password unset ⇒ 404 (never
// an accidentally open dashboard). Everything else in the app is untouched.
import { NextResponse, type NextRequest } from "next/server";
import { COOKIE_NAME, isProtectedPath, verifySession } from "./lib/monitoring/auth";

export const config = { matcher: ["/monitoring/:path*", "/api/monitoring/traces/:path*", "/api/monitoring/traces", "/api/monitoring/stats", "/api/monitoring/sessions/:path*"] };

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const password = process.env.MONITORING_PASSWORD?.trim();
  const secret = process.env.MONITORING_COOKIE_SECRET?.trim();
  if (!password || !secret) return new NextResponse(null, { status: 404 });
  if (!isProtectedPath(pathname)) return NextResponse.next();
  if (await verifySession(secret, req.cookies.get(COOKIE_NAME)?.value)) return NextResponse.next();
  if (pathname.startsWith("/api/")) return NextResponse.json({ detail: "Unauthorized" }, { status: 401 });
  const url = req.nextUrl.clone(); url.pathname = "/monitoring/login"; url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}
```

- [ ] **Step 5: `app/api/monitoring/auth/route.ts`**

```ts
import { dashboardEnabled } from "@/lib/monitoring/env";
import { COOKIE_MAX_AGE_SEC, COOKIE_NAME, cookieHeader, createLoginThrottle, passwordMatches, signSession } from "@/lib/monitoring/auth";

export const runtime = "nodejs";
const throttle = createLoginThrottle();
const ipOf = (req: Request) => req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";

export async function POST(req: Request): Promise<Response> {
  if (!dashboardEnabled()) return new Response(null, { status: 404 });
  const ip = ipOf(req);
  if (!throttle.check(ip)) return Response.json({ detail: "Too many attempts. Try again later." }, { status: 429 });
  let password = "";
  try { password = String(((await req.json()) as { password?: unknown }).password ?? ""); } catch { /* empty */ }
  if (!(await passwordMatches(process.env.MONITORING_PASSWORD!.trim(), password))) {
    throttle.fail(ip);
    return Response.json({ detail: "Wrong password." }, { status: 401 });
  }
  const token = await signSession(process.env.MONITORING_COOKIE_SECRET!.trim(), Math.floor(Date.now() / 1000) + COOKIE_MAX_AGE_SEC);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json", "set-cookie": cookieHeader(token, process.env.NODE_ENV === "production") } });
}

export async function DELETE(): Promise<Response> {
  return new Response(null, { status: 204, headers: { "set-cookie": `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` } });
}
```

- [ ] **Step 6: `app/monitoring/login/page.tsx`** (client component; the monitoring layout from Task 12 wraps it)

```tsx
"use client";
import { useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { Lock } from "lucide-react";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const next = useSearchParams().get("next") ?? "/monitoring";
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    const res = await fetch("/api/monitoring/auth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
    setBusy(false);
    if (res.ok) { window.location.assign(next.startsWith("/monitoring") ? next : "/monitoring"); return; }
    setError(res.status === 429 ? "Too many attempts — wait 15 minutes." : "Wrong password.");
  }
  return (
    <main className="flex min-h-screen items-center justify-center bg-(--bg) px-4 font-body text-(--fg)">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-(--border) bg-(--surface) p-6 soft-shadow">
        <div className="mb-4 flex items-center gap-2 font-display text-lg font-semibold"><Lock className="h-5 w-5 text-(--brand-green)" /> Navio Monitoring</div>
        <label className="font-display text-[13px] font-medium" htmlFor="pw">Password</label>
        <input id="pw" type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)}
          className="mt-1 w-full rounded-xl border border-(--border) bg-(--surface-muted) px-3 py-2 text-sm outline-none focus:border-(--brand-green)" />
        {error && <p className="mt-2 text-sm text-(--red)" role="alert">{error}</p>}
        <button disabled={busy || !password} className="mt-4 w-full rounded-full bg-(--brand-green) px-4 py-2 font-display text-sm font-semibold text-white disabled:opacity-50">Sign in</button>
      </form>
    </main>
  );
}
```

- [ ] **Step 7: Run** tests + typecheck — PASS. Manual: `curl -i http://127.0.0.1:3001/api/monitoring/stats` → 401; browser `/monitoring` → redirect to login; wrong password → "Wrong password."; correct → cookie set. Temporarily blank `MONITORING_PASSWORD`, restart → `/monitoring` 404. Restore.

- [ ] **Step 8: Commit**

```bash
git add lib/monitoring/auth.ts middleware.ts app/api/monitoring/auth/route.ts app/monitoring/login/page.tsx tests/monitoring-auth.test.ts
git commit -m "monitoring: password login with signed httpOnly cookie; middleware guards /monitoring and its data API"
```

---

### Task 11: Read side — `query.ts` + data API routes

**Files:**
- Create: `lib/monitoring/query.ts`, `app/api/monitoring/traces/route.ts`, `app/api/monitoring/traces/[id]/route.ts`, `app/api/monitoring/stats/route.ts`, `app/api/monitoring/sessions/[id]/route.ts`
- Test: `tests/monitoring-query.test.ts` (pure helpers only: filter parsing + step tree building)

**Interfaces (produced):**
```ts
export interface TraceRow { id; session_id; agent; agent_version; turn_id; turn_index; status; started_at; ended_at; duration_ms; first_token_ms; user_input; final_output; prompt_version_id; models; tools_called; step_count; tool_call_count; error_count; warning_count; tokens_input; tokens_output; tokens_cached; cost_estimate_usd; feedback_thumb; metadata }
export interface StepRow { id; trace_id; parent_step_id; step_key; parent_key; sequence; kind; name; title; purpose; status; started_at; duration_ms; input; output; tool_name; model; tokens_input; tokens_output; tokens_cached; cost_estimate_usd; warnings; error; metadata }
export interface StepNode extends StepRow { children: StepNode[] }
export interface TraceFilters { agent?: "faq"|"partner"; status?: TraceStatus; thumb?: "up"|"down"|"none"; q?: string; from?: string; to?: string; cursor?: string; limit?: number }
export function parseTraceFilters(params: URLSearchParams): TraceFilters;
export function buildStepTree(rows: StepRow[]): StepNode[];
export async function listTraces(f: TraceFilters): Promise<{ items: TraceRow[]; nextCursor: string | null }>;
export async function getTrace(id: string, opts?: { prompt?: boolean }): Promise<{ trace: TraceRow; steps: StepNode[]; errors: ErrorRow[]; feedback: FeedbackRow[]; prompt?: PromptRow | null } | null>;
export async function getStats(range: "24h"|"7d"|"30d"): Promise<Stats | null>;
export async function getSession(id: string): Promise<{ session: SessionRow; traces: TraceRow[] } | null>;
export function traceIsAbandoned(t: Pick<TraceRow, "status"|"started_at">, now?: number): boolean; // running > 5 min
```
Cursor = `${started_at}|${id}` of the last item; pagination `started_at < cursorStart or (= and id < cursorId)`, implemented as two `.or()` filters on the Supabase query builder. `q` uses `ilike` on `user_input` and `final_output` (`.or(\`user_input.ilike.%q%,final_output.ilike.%q%\`)`, with `%`/`,` escaped out of `q`).

- [ ] **Step 1: Failing tests** — `tests/monitoring-query.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { parseTraceFilters, buildStepTree, traceIsAbandoned } from "../lib/monitoring/query";

describe("query helpers", () => {
  it("parses filters and clamps limit", () => {
    const f = parseTraceFilters(new URLSearchParams("agent=faq&status=failed&thumb=down&q=Yoga&limit=500&cursor=x"));
    expect(f).toMatchObject({ agent: "faq", status: "failed", thumb: "down", q: "Yoga", limit: 200, cursor: "x" });
    expect(parseTraceFilters(new URLSearchParams("agent=bogus&status=nope")).agent).toBeUndefined();
    expect(parseTraceFilters(new URLSearchParams("")).limit).toBe(50);
  });
  it("builds the step tree by parent_step_id, ordered by sequence", () => {
    const row = (o: Record<string, unknown>) => ({ id: "", trace_id: "t", parent_step_id: null, step_key: "", parent_key: null, sequence: 0, kind: "request", name: "", title: "", purpose: "", status: "ok", started_at: null, duration_ms: null, input: null, output: null, tool_name: null, model: null, tokens_input: null, tokens_output: null, tokens_cached: null, cost_estimate_usd: null, warnings: [], error: null, metadata: {}, ...o }) as never;
    const tree = buildStepTree([row({ id: "c2", parent_step_id: "g", sequence: 2 }), row({ id: "g", sequence: 2, kind: "group" }), row({ id: "r", sequence: 1 }), row({ id: "c1", parent_step_id: "g", sequence: 1 })]);
    expect(tree.map((n) => n.id)).toEqual(["r", "g"]);
    expect(tree[1]!.children.map((n) => n.id)).toEqual(["c1", "c2"]);
  });
  it("abandoned = running for more than 5 minutes", () => {
    const now = Date.parse("2026-09-14T10:10:00Z");
    expect(traceIsAbandoned({ status: "running", started_at: "2026-09-14T10:00:00Z" }, now)).toBe(true);
    expect(traceIsAbandoned({ status: "running", started_at: "2026-09-14T10:08:00Z" }, now)).toBe(false);
    expect(traceIsAbandoned({ status: "completed", started_at: "2026-09-14T09:00:00Z" }, now)).toBe(false);
  });
});
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Write `lib/monitoring/query.ts`**

```ts
// Read side for the dashboard. Server-only (service-role client from store.ts).
import "server-only";
import { supabaseAdmin } from "./store";
import type { Agent, StepKind, StepStatus, TraceStatus } from "./types";

export interface TraceRow { id: string; session_id: string; agent: Agent; agent_version: string | null; turn_id: string; turn_index: number | null; status: TraceStatus; started_at: string; ended_at: string | null; duration_ms: number | null; first_token_ms: number | null; user_input: string | null; final_output: string | null; prompt_version_id: string | null; models: string[]; tools_called: string[]; step_count: number; tool_call_count: number; error_count: number; warning_count: number; tokens_input: number | null; tokens_output: number | null; tokens_cached: number | null; cost_estimate_usd: number | null; feedback_thumb: "up" | "down" | null; metadata: Record<string, unknown> }
export interface StepRow { id: string; trace_id: string; parent_step_id: string | null; step_key: string; parent_key: string | null; sequence: number; kind: StepKind; name: string; title: string; purpose: string; status: StepStatus; started_at: string | null; duration_ms: number | null; input: unknown; output: unknown; tool_name: string | null; model: string | null; tokens_input: number | null; tokens_output: number | null; tokens_cached: number | null; cost_estimate_usd: number | null; warnings: string[]; error: { message: string; type?: string } | null; metadata: Record<string, unknown> }
export interface StepNode extends StepRow { children: StepNode[] }
export interface ErrorRow { id: string; trace_id: string; step_id: string | null; level: "error" | "warning"; type: string; message: string; created_at: string }
export interface FeedbackRow { id: string; trace_id: string | null; thumb: "up" | "down" | null; reason: string | null; comment: string | null; epoch: number; created_at: string }
export interface PromptRow { id: string; sha256: string; size_chars: number; approx_tokens: number; sections: string[]; content?: string; first_seen_at: string }
export interface SessionRow { id: string; agent: Agent; first_seen_at: string; last_seen_at: string; turn_count: number; origin: string | null }
export interface Stats { executions: number; succeeded: number; failed: number; abandoned: number; avg_ms: number | null; p95_ms: number | null; cost_usd: number; thumbs_up: number; thumbs_down: number; per_day: { day: string; agent: Agent; n: number }[]; latest_errors: (ErrorRow & { agent: Agent; user_input: string | null })[] }
export interface TraceFilters { agent?: Agent; status?: TraceStatus; thumb?: "up" | "down" | "none"; q?: string; from?: string; to?: string; cursor?: string; limit?: number }

const STATUSES: TraceStatus[] = ["running", "completed", "needs_clarification", "partial", "failed"];
export function parseTraceFilters(p: URLSearchParams): TraceFilters {
  const agent = p.get("agent"); const status = p.get("status"); const thumb = p.get("thumb");
  const limit = Math.min(200, Math.max(1, Number(p.get("limit")) || 50));
  return {
    agent: agent === "faq" || agent === "partner" ? agent : undefined,
    status: STATUSES.includes(status as TraceStatus) ? (status as TraceStatus) : undefined,
    thumb: thumb === "up" || thumb === "down" || thumb === "none" ? thumb : undefined,
    q: p.get("q")?.trim() || undefined, from: p.get("from") || undefined, to: p.get("to") || undefined, cursor: p.get("cursor") || undefined, limit,
  };
}
export function buildStepTree(rows: StepRow[]): StepNode[] {
  const nodes = new Map<string, StepNode>(rows.map((r) => [r.id, { ...r, children: [] }]));
  const roots: StepNode[] = [];
  for (const n of nodes.values()) { const parent = n.parent_step_id ? nodes.get(n.parent_step_id) : undefined; (parent ? parent.children : roots).push(n); }
  const sort = (list: StepNode[]) => { list.sort((a, b) => a.sequence - b.sequence); list.forEach((n) => sort(n.children)); };
  sort(roots); return roots;
}
export function traceIsAbandoned(t: { status: string; started_at: string }, now: number = Date.now()): boolean {
  return t.status === "running" && now - Date.parse(t.started_at) > 5 * 60_000;
}
const escapeLike = (s: string) => s.replace(/[%,()]/g, " ");

export async function listTraces(f: TraceFilters): Promise<{ items: TraceRow[]; nextCursor: string | null }> {
  const db = supabaseAdmin(); if (!db) return { items: [], nextCursor: null };
  const limit = f.limit ?? 50;
  let q = db.from("traces").select("*").order("started_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1);
  if (f.agent) q = q.eq("agent", f.agent);
  if (f.status) q = q.eq("status", f.status);
  if (f.thumb === "none") q = q.is("feedback_thumb", null); else if (f.thumb) q = q.eq("feedback_thumb", f.thumb);
  if (f.from) q = q.gte("started_at", f.from);
  if (f.to) q = q.lte("started_at", f.to);
  if (f.q) { const s = escapeLike(f.q); q = q.or(`user_input.ilike.%${s}%,final_output.ilike.%${s}%`); }
  if (f.cursor) { const [cs, cid] = f.cursor.split("|"); if (cs && cid) q = q.or(`started_at.lt.${cs},and(started_at.eq.${cs},id.lt.${cid})`); }
  const { data, error } = await q;
  if (error || !data) return { items: [], nextCursor: null };
  const items = data.slice(0, limit) as TraceRow[];
  const last = items.at(-1);
  return { items, nextCursor: data.length > limit && last ? `${last.started_at}|${last.id}` : null };
}

export async function getTrace(id: string, opts: { prompt?: boolean } = {}) {
  const db = supabaseAdmin(); if (!db) return null;
  const { data: trace } = await db.from("traces").select("*").eq("id", id).maybeSingle();
  if (!trace) return null;
  const [steps, errors, feedback, prompt] = await Promise.all([
    db.from("trace_steps").select("*").eq("trace_id", id).order("sequence"),
    db.from("errors").select("*").eq("trace_id", id).order("created_at"),
    db.from("feedback").select("*").eq("trace_id", id).order("created_at"),
    trace.prompt_version_id
      ? db.from("prompt_versions").select(opts.prompt ? "*" : "id,sha256,size_chars,approx_tokens,sections,first_seen_at").eq("id", trace.prompt_version_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  return { trace: trace as TraceRow, steps: buildStepTree((steps.data ?? []) as StepRow[]), errors: (errors.data ?? []) as ErrorRow[], feedback: (feedback.data ?? []) as FeedbackRow[], prompt: (prompt.data as PromptRow | null) ?? null };
}

export async function getStats(range: "24h" | "7d" | "30d"): Promise<Stats | null> {
  const db = supabaseAdmin(); if (!db) return null;
  const hours = range === "24h" ? 24 : range === "7d" ? 24 * 7 : 24 * 30;
  const { data, error } = await db.rpc("monitoring_stats", { p_hours: hours });
  return error ? null : (data as Stats);
}

export async function getSession(id: string): Promise<{ session: SessionRow; traces: TraceRow[] } | null> {
  const db = supabaseAdmin(); if (!db) return null;
  const { data: session } = await db.from("agent_sessions").select("*").eq("id", id).maybeSingle();
  if (!session) return null;
  const { data } = await db.from("traces").select("*").eq("session_id", id).order("started_at");
  return { session: session as SessionRow, traces: (data ?? []) as TraceRow[] };
}
```
Add `"server-only"` to `package.json` dependencies (`npm i server-only`), or — if you prefer no new dep — drop the import; the module is only ever imported from server files. For the unit test, vitest must not choke on `server-only`: add `resolve: { alias: { "server-only": new URL("./tests/_server-only-stub.ts", import.meta.url).pathname } }` to `vitest.config.ts` with an empty stub file. Choose the no-dep route (drop the import) if this becomes friction — note it in the commit message.

- [ ] **Step 4: Routes** (all `export const runtime = "nodejs"; export const dynamic = "force-dynamic";`, each returns 404 when `!dashboardEnabled()` as a belt to the middleware's braces):

```ts
// app/api/monitoring/traces/route.ts
import { dashboardEnabled } from "@/lib/monitoring/env";
import { listTraces, parseTraceFilters } from "@/lib/monitoring/query";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  if (!dashboardEnabled()) return new Response(null, { status: 404 });
  return Response.json(await listTraces(parseTraceFilters(new URL(req.url).searchParams)));
}
// app/api/monitoring/traces/[id]/route.ts
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!dashboardEnabled()) return new Response(null, { status: 404 });
  const { id } = await params;
  const t = await getTrace(id, { prompt: new URL(req.url).searchParams.get("prompt") === "1" });
  return t ? Response.json(t) : Response.json({ detail: "Not found" }, { status: 404 });
}
// app/api/monitoring/stats/route.ts
export async function GET(req: Request) {
  if (!dashboardEnabled()) return new Response(null, { status: 404 });
  const r = new URL(req.url).searchParams.get("range"); const range = r === "7d" || r === "30d" ? r : "24h";
  const s = await getStats(range); return s ? Response.json(s) : Response.json({ detail: "Unavailable" }, { status: 503 });
}
// app/api/monitoring/sessions/[id]/route.ts
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!dashboardEnabled()) return new Response(null, { status: 404 });
  const s = await getSession((await params).id); return s ? Response.json(s) : Response.json({ detail: "Not found" }, { status: 404 });
}
```

- [ ] **Step 5: Run** tests + typecheck — PASS. Manual (logged in, cookie in curl): `curl -b "navio_monitoring=<token>" "http://127.0.0.1:3001/api/monitoring/traces?agent=faq"` → JSON with the Task 8 trace; `/api/monitoring/stats?range=24h` → executions ≥ 2.

- [ ] **Step 6: Commit**

```bash
git add lib/monitoring/query.ts app/api/monitoring/traces app/api/monitoring/stats app/api/monitoring/sessions tests/monitoring-query.test.ts vitest.config.ts package.json package-lock.json
git commit -m "monitoring: read queries (list, detail tree, stats, session) and the guarded data API"
```

---

### Task 12: Dashboard shell + Overview screen

**Files:**
- Create: `app/monitoring/layout.tsx`, `app/monitoring/page.tsx`, `components/monitoring/ui.tsx` (`StatusPill`, `AgentBadge`, `Thumb`, `fmtMs`, `fmtUsd`, `fmtTime`), `components/monitoring/ThemeToggle.tsx`, `components/monitoring/KpiTiles.tsx`, `components/monitoring/PerDayBars.tsx`, `components/monitoring/TraceFilters.tsx`, `components/monitoring/TraceList.tsx`
- Test: `tests/monitoring-ui.test.ts` (formatters only)

Pages are **server components** that call `lib/monitoring/query.ts` directly; the data API from Task 11 serves scripts/curl. Interactivity (filters form, theme toggle, "load more") lives in small client components. Dark mode: the layout root toggles `theme-dark` (same class the widget uses; tokens already exist in `app/globals.css`), persisted in `localStorage("navio-monitoring-theme")`.

**Interfaces (produced) — `components/monitoring/ui.tsx`:**
```tsx
export function fmtMs(ms: number | null | undefined): string;    // 850 → "850 ms", 4800 → "4.8 s", 61000 → "1:01 min"
export function fmtUsd(usd: number | null | undefined): string;  // 0.0021 → "$0.0021", null → "—"
export function fmtTime(iso: string): string;                    // "14.09. 10:42:07"
export function StatusPill({ status, abandoned }: { status: string; abandoned?: boolean }): JSX.Element;  // completed=green, needs_clarification/partial=orange, failed=red, running=grey, abandoned=red "abandoned"
export function AgentBadge({ agent }: { agent: "faq" | "partner" }): JSX.Element;  // "FAQ" / "Partner"
export function Thumb({ thumb }: { thumb: "up" | "down" | null }): JSX.Element;
```

- [ ] **Step 1: Failing test** — `tests/monitoring-ui.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { fmtMs, fmtUsd, fmtTime } from "../components/monitoring/ui";
describe("dashboard formatters", () => {
  it("durations", () => { expect(fmtMs(850)).toBe("850 ms"); expect(fmtMs(4800)).toBe("4.8 s"); expect(fmtMs(61000)).toBe("1:01 min"); expect(fmtMs(null)).toBe("—"); });
  it("money", () => { expect(fmtUsd(0.0021)).toBe("$0.0021"); expect(fmtUsd(0)).toBe("$0.0000"); expect(fmtUsd(null)).toBe("—"); });
  it("time", () => { expect(fmtTime("2026-09-14T08:42:07.000Z")).toMatch(/^\d{2}\.\d{2}\. \d{2}:\d{2}:\d{2}$/); });
});
```

- [ ] **Step 2: Run** — FAIL. **Step 3: `components/monitoring/ui.tsx`**

```tsx
import { ThumbsDown, ThumbsUp } from "lucide-react";

export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000); const s = Math.round((ms % 60_000) / 1000);
  return `${m}:${String(s).padStart(2, "0")} min`;
}
export function fmtUsd(usd: number | null | undefined): string { return usd === null || usd === undefined ? "—" : `$${Number(usd).toFixed(4)}`; }
export function fmtTime(iso: string): string {
  const d = new Date(iso); const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}. ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
const PILL: Record<string, string> = {
  completed: "bg-(--accent-dim) text-(--brand-green)", needs_clarification: "bg-(--warn-surface) text-(--warn-fg)", partial: "bg-(--warn-surface) text-(--warn-fg)",
  failed: "bg-[rgba(244,63,94,0.12)] text-(--red)", running: "bg-(--surface-muted) text-(--fg-muted)", abandoned: "bg-[rgba(244,63,94,0.12)] text-(--red)",
  ok: "bg-(--accent-dim) text-(--brand-green)", warning: "bg-(--warn-surface) text-(--warn-fg)", error: "bg-[rgba(244,63,94,0.12)] text-(--red)", skipped: "bg-(--surface-muted) text-(--fg-subtle)",
};
const LABEL: Record<string, string> = { completed: "Completed", needs_clarification: "Needs clarification", partial: "Partial", failed: "Failed", running: "Running", abandoned: "Abandoned", ok: "OK", warning: "Warning", error: "Error", skipped: "Skipped" };
export function StatusPill({ status, abandoned }: { status: string; abandoned?: boolean }) {
  const s = abandoned ? "abandoned" : status;
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 font-display text-[12px] font-medium ${PILL[s] ?? PILL.running}`}>{LABEL[s] ?? s}</span>;
}
export function AgentBadge({ agent }: { agent: "faq" | "partner" }) {
  return <span className="inline-flex rounded-md border border-(--border) px-1.5 py-0.5 font-display text-[11px] font-semibold uppercase tracking-wide text-(--fg-muted)">{agent === "faq" ? "FAQ" : "Partner"}</span>;
}
export function Thumb({ thumb }: { thumb: "up" | "down" | null }) {
  if (thumb === "up") return <ThumbsUp className="h-4 w-4 text-(--brand-green)" aria-label="thumbs up" />;
  if (thumb === "down") return <ThumbsDown className="h-4 w-4 text-(--red)" aria-label="thumbs down" />;
  return <span className="text-(--fg-subtle)">—</span>;
}
```

- [ ] **Step 4: `components/monitoring/ThemeToggle.tsx`** (client)

```tsx
"use client";
import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
export function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => { try { const v = localStorage.getItem("navio-monitoring-theme"); if (v === "dark") setDark(true); } catch { /* ignore */ } }, []);
  useEffect(() => { document.getElementById("monitoring-root")?.classList.toggle("theme-dark", dark); try { localStorage.setItem("navio-monitoring-theme", dark ? "dark" : "light"); } catch { /* ignore */ } }, [dark]);
  return <button type="button" onClick={() => setDark((d) => !d)} aria-label="Toggle theme" className="flex h-9 w-9 items-center justify-center rounded-full border border-(--border) text-(--fg-muted) hover:bg-(--surface-muted)">{dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}</button>;
}
```

- [ ] **Step 5: `app/monitoring/layout.tsx`**

```tsx
import Link from "next/link";
import { Activity } from "lucide-react";
import { ThemeToggle } from "@/components/monitoring/ThemeToggle";
export const metadata = { title: "Navio Monitoring" };
export default function MonitoringLayout({ children }: { children: React.ReactNode }) {
  return (
    <div id="monitoring-root" className="min-h-screen bg-(--bg) font-body text-(--fg)">
      <header className="sticky top-0 z-10 border-b border-(--border) bg-(--surface)">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <Link href="/monitoring" className="flex items-center gap-2 font-display text-base font-semibold"><Activity className="h-5 w-5 text-(--brand-green)" /> Navio Monitoring</Link>
          <div className="flex items-center gap-2"><ThemeToggle /><form action="/api/monitoring/auth" method="post" onSubmit={undefined}><LogoutButton /></form></div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
```
with `components/monitoring/LogoutButton.tsx` (client): a button that `fetch("/api/monitoring/auth", { method: "DELETE" })` then `location.assign("/monitoring/login")`. (Replace the `<form>` wrapper with just `<LogoutButton />`; the form is unnecessary.)

- [ ] **Step 6: `components/monitoring/KpiTiles.tsx`** — server component, props `{ stats: Stats }`: 8 tiles in a `grid grid-cols-2 gap-3 sm:grid-cols-4`: Executions · Success rate (`succeeded/executions`, "—" when 0) · Failed (+ abandoned in small text) · Avg latency (`fmtMs(avg_ms)`) · p95 latency · Total cost (`fmtUsd`) · 👍 rate (`thumbs_up/(up+down)`) · Rated (`up+down`). Tile = `rounded-2xl border border-(--border) bg-(--surface) p-4`, label `text-xs text-(--fg-subtle)`, value `font-display text-2xl font-semibold`.

- [ ] **Step 7: `components/monitoring/PerDayBars.tsx`** — server component, props `{ perDay: Stats["per_day"] }`: groups by day, one stacked bar per day (FAQ = `bg-(--brand-green)`, Partner = `bg-(--brand-orange)`), heights proportional to the day max, day label under each bar, a legend. Pure CSS flex, no chart lib. Empty state: "No executions in this range."

- [ ] **Step 8: `components/monitoring/TraceFilters.tsx`** (client) — a `<form method="get">` with selects `agent` (All/FAQ/Partner), `status` (All + 5), `thumb` (All/👍/👎/none), `range` (24h/7d/30d — also drives the KPIs), text `q`, and a submit "Filter". Reads initial values from `useSearchParams()`. Submitting reloads `/monitoring?…` (server re-renders).

- [ ] **Step 9: `components/monitoring/TraceList.tsx`** — server component, props `{ items: TraceRow[]; nextCursor: string | null; params: URLSearchParams }`. Table inside `overflow-x-auto`: Time · Agent · Question (truncate 80 chars, `title` attr full) · Status (`StatusPill` with `abandoned={traceIsAbandoned(t)}`) · Duration · Cost · Steps/Tools (`7 · 2`) · Feedback (`Thumb`). Row = `<Link href={`/monitoring/traces/${t.id}`}>` on the question cell + `hover:bg-(--surface-muted)`. Footer "Load more" link to `?…&cursor=<nextCursor>` when present. Empty state text.

- [ ] **Step 10: `app/monitoring/page.tsx`**

```tsx
import { getStats, listTraces, parseTraceFilters } from "@/lib/monitoring/query";
import { KpiTiles } from "@/components/monitoring/KpiTiles";
import { PerDayBars } from "@/components/monitoring/PerDayBars";
import { TraceFilters } from "@/components/monitoring/TraceFilters";
import { TraceList } from "@/components/monitoring/TraceList";
import { fmtTime, AgentBadge } from "@/components/monitoring/ui";
import Link from "next/link";
export const dynamic = "force-dynamic";
export default async function OverviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = new URLSearchParams(Object.entries(await searchParams).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : [])));
  const r = sp.get("range"); const range = r === "7d" || r === "30d" ? r : "24h";
  const filters = parseTraceFilters(sp);
  const since = new Date(Date.now() - (range === "24h" ? 1 : range === "7d" ? 7 : 30) * 86_400_000).toISOString();
  const [stats, list] = await Promise.all([getStats(range), listTraces({ ...filters, from: filters.from ?? since })]);
  return (
    <div className="space-y-6">
      <TraceFilters />
      {stats ? <KpiTiles stats={stats} /> : <p className="text-sm text-(--fg-muted)">Monitoring database not configured.</p>}
      {stats && (
        <div className="grid gap-4 lg:grid-cols-3">
          <section className="rounded-2xl border border-(--border) bg-(--surface) p-4 lg:col-span-2"><h2 className="mb-3 font-display text-sm font-semibold">Executions per day</h2><PerDayBars perDay={stats.per_day} /></section>
          <section className="rounded-2xl border border-(--border) bg-(--surface) p-4"><h2 className="mb-3 font-display text-sm font-semibold">Latest errors</h2>
            {stats.latest_errors.length === 0 ? <p className="text-sm text-(--fg-subtle)">None in this range.</p> : (
              <ul className="space-y-2 text-sm">{stats.latest_errors.map((e) => (
                <li key={e.id}><Link href={`/monitoring/traces/${e.trace_id}`} className="block rounded-lg p-2 hover:bg-(--surface-muted)"><div className="flex items-center gap-2 text-xs text-(--fg-subtle)"><AgentBadge agent={e.agent} />{fmtTime(e.created_at)} · {e.type}</div><div className="truncate text-(--red)">{e.message}</div></Link></li>))}</ul>)}
          </section>
        </div>)}
      <TraceList items={list.items} nextCursor={list.nextCursor} params={sp} />
    </div>
  );
}
```

- [ ] **Step 11: Run** tests + typecheck; open `/monitoring` logged in — KPIs, bars, error list, trace rows for the FAQ + partner traces created earlier; filters work; 400 px width shows the table scrolling horizontally and tiles in 2 columns; dark toggle persists across reload.

- [ ] **Step 12: Commit**

```bash
git add app/monitoring/layout.tsx app/monitoring/page.tsx components/monitoring tests/monitoring-ui.test.ts
git commit -m "monitoring: dashboard shell and overview (KPIs, per-day bars, latest errors, filterable trace list)"
```

---

### Task 13: Trace detail screen (timeline)

**Files:**
- Create: `app/monitoring/traces/[id]/page.tsx`, `components/monitoring/Timeline.tsx` (client), `components/monitoring/StepCard.tsx` (client), `components/monitoring/JsonView.tsx` (client), `components/monitoring/TraceSidebar.tsx`, `components/monitoring/PromptDialog.tsx` (client)
- Test: `tests/monitoring-timeline.test.ts` (pure helpers: `laneLayout`, `durationPct`, `tableFor`)

**Interfaces (produced) — in `components/monitoring/timeline-model.ts` (pure, testable):**
```ts
export function durationPct(step: { duration_ms: number | null }, total: number): number;            // 0..100, min 2 when > 0
export function laneLayout(top: StepNode[]): Array<{ kind: "step"; step: StepNode } | { kind: "lanes"; groups: StepNode[] }>;  // consecutive `group` steps collapse into one lanes row
export function tableFor(step: StepNode): { columns: string[]; rows: Record<string, unknown>[] } | null; // search → candidates table; rerank → rows table; respond → recommendations; else null
export function stepIcon(kind: StepKind): LucideIconName;  // request=MessageSquare, llm=Sparkles, tool=Wrench, retrieval=Database, transform=Shuffle, response=Send, error=AlertTriangle, group=Layers
```

- [ ] **Step 1: Failing tests**

```ts
import { describe, it, expect } from "vitest";
import { durationPct, laneLayout, tableFor } from "../components/monitoring/timeline-model";
const node = (o: Record<string, unknown>) => ({ id: String(o.id ?? Math.random()), children: [], kind: "llm", name: "", status: "ok", duration_ms: 0, sequence: 0, input: null, output: null, metadata: {}, ...o }) as never;
describe("timeline model", () => {
  it("duration percentage is bounded and never invisible", () => {
    expect(durationPct({ duration_ms: 500 }, 1000)).toBe(50); expect(durationPct({ duration_ms: 1 }, 100000)).toBe(2); expect(durationPct({ duration_ms: null }, 1000)).toBe(0); expect(durationPct({ duration_ms: 5000 }, 1000)).toBe(100);
  });
  it("consecutive task groups render side by side", () => {
    const rows = laneLayout([node({ id: "a" }), node({ id: "g1", kind: "group" }), node({ id: "g2", kind: "group" }), node({ id: "z" })]);
    expect(rows.map((r) => r.kind)).toEqual(["step", "lanes", "step"]);
    expect((rows[1] as { groups: { id: string }[] }).groups.map((g) => g.id)).toEqual(["g1", "g2"]);
  });
  it("tabular views for search candidates, rerank rows and recommendations", () => {
    expect(tableFor(node({ name: "search", output: { candidates: [{ id: 1, name: "A", city: "Bochum", similarity: 0.5, role: "target", distanceKm: 0 }] } }))!.rows).toHaveLength(1);
    expect(tableFor(node({ name: "rerank", output: { rows: [{ rank: 1, name: "A", finalScore: 0.9, kept: true }] } }))!.columns).toContain("finalScore");
    expect(tableFor(node({ name: "respond", output: { recommendations: [{ rank: 1, name: "A", city: "Bochum", distanceKm: 1 }] } }))!.rows).toHaveLength(1);
    expect(tableFor(node({ name: "reformulate", output: { retrievalQuery: "x" } }))).toBeNull();
  });
});
```

- [ ] **Step 2: Run** — FAIL. **Step 3: `components/monitoring/timeline-model.ts`**

```ts
import type { StepNode } from "@/lib/monitoring/query";
export function durationPct(step: { duration_ms: number | null }, total: number): number {
  if (!step.duration_ms || total <= 0) return 0;
  return Math.max(2, Math.min(100, Math.round((step.duration_ms / total) * 100)));
}
export type LayoutRow = { kind: "step"; step: StepNode } | { kind: "lanes"; groups: StepNode[] };
export function laneLayout(top: StepNode[]): LayoutRow[] {
  const rows: LayoutRow[] = [];
  for (const s of top) {
    const last = rows.at(-1);
    if (s.kind === "group") { if (last?.kind === "lanes") last.groups.push(s); else rows.push({ kind: "lanes", groups: [s] }); }
    else rows.push({ kind: "step", step: s });
  }
  return rows;
}
const pick = (rows: unknown, cols: string[]) => Array.isArray(rows) && rows.length ? { columns: cols, rows: rows.map((r) => Object.fromEntries(cols.map((c) => [c, (r as Record<string, unknown>)[c]]))) } : null;
export function tableFor(step: StepNode): { columns: string[]; rows: Record<string, unknown>[] } | null {
  const out = (step.output ?? {}) as Record<string, unknown>;
  if (step.name === "search") return pick(out.candidates, ["id", "name", "city", "role", "distanceKm", "similarity", "rankInCity"]);
  if (step.name === "rerank") return pick(out.rows, ["rank", "name", "city", "role", "relevance", "locationTerm", "finalScore", "kept", "dropReason"]);
  if (step.name === "respond") return pick(out.recommendations, ["rank", "name", "city", "role", "distanceKm", "finalScore"]);
  return null;
}
```

- [ ] **Step 4: `components/monitoring/JsonView.tsx`** (client) — props `{ value: unknown; label: string }`. Renders `<pre>` with `JSON.stringify(value, null, 2)`; when the string is > 4000 chars shows the first 4000 + a "Show all (N KB)" button; a "Copy" button using `navigator.clipboard.writeText`. Strings (e.g. an answer) render as wrapped text, not JSON.

- [ ] **Step 5: `components/monitoring/StepCard.tsx`** (client) — props `{ step: StepNode; total: number; open: boolean; onToggle(): void; focused: boolean; depth: number }`. Layout: icon (from `stepIcon`), `title` (Outfit, semibold), `purpose` (fg-muted, one line), right side `fmtMs(duration_ms)` + `StatusPill status={step.status}`; below a 4 px bar `style={{ width: durationPct + "%" }}` green / orange (warning) / red (error). When `open`: sections **Input** and **Output** (`JsonView`; plus `tableFor(step)` rendered as a table above the raw JSON when non-null), **Config** (`metadata.config` when present), **Warnings** (`warnings` list, orange), **Error** (`error.message`, red), and a `<details>` **Technical details** with step_key, kind, name, model, tokens (in/out/cached), cost, started_at, metadata (JsonView). Focus ring when `focused` (`ring-2 ring-(--brand-green)`). Children (for groups) render nested with `depth+1`.

- [ ] **Step 6: `components/monitoring/Timeline.tsx`** (client) — props `{ steps: StepNode[]; totalMs: number }`. State: `open: Set<string>` (default empty = collapsed), `focus: number`. Flattens the visible steps for keyboard: `j`/`k` move focus, `e` expands all, `c` collapses all, `Enter`/`Space` toggles the focused card (only when the event target is not an input). Renders `laneLayout(steps)`: `step` rows as `StepCard`; `lanes` rows as `grid gap-3 md:grid-cols-{n}` (n = groups.length, max 3; stacks on narrow screens) where each lane is a `StepCard` for the group with its children rendered inside (each child a `StepCard depth=1`). A vertical rail (`border-l-2 border-(--border) pl-4`) on the left. Toolbar above: "Expand all" / "Collapse all" buttons + the keyboard hint `j k e c`.

- [ ] **Step 7: `components/monitoring/TraceSidebar.tsx`** (server) — props `{ trace, prompt, feedback }`: cards for **Prompt version** (`sha256` first 12 chars, size, approx tokens, sections; `PromptDialog` button "Open full prompt" fetching `/api/monitoring/traces/:id?prompt=1` on click and showing `prompt.content` in a `<dialog>`; hidden for partner traces), **Models** (`models.join`), **Tokens** (in/out/cached), **Cost**, **Session** (link `/monitoring/sessions/<session_id>` + turn index), **Feedback history** (each row: time, `Thumb`, reason, comment, "retracted" when thumb null), **Langfuse** (`metadata.langfuse_session_id` if present) and **Version** (`agent_version`, `metadata.env`).

- [ ] **Step 8: `app/monitoring/traces/[id]/page.tsx`**

```tsx
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getTrace, traceIsAbandoned } from "@/lib/monitoring/query";
import { AgentBadge, StatusPill, Thumb, fmtMs, fmtTime, fmtUsd } from "@/components/monitoring/ui";
import { Timeline } from "@/components/monitoring/Timeline";
import { TraceSidebar } from "@/components/monitoring/TraceSidebar";
export const dynamic = "force-dynamic";
export default async function TracePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const t = await getTrace(id);
  if (!t) notFound();
  const { trace, steps, errors, feedback, prompt } = t;
  return (
    <div className="space-y-5">
      <Link href="/monitoring" className="inline-flex items-center gap-1 text-sm text-(--fg-muted) hover:text-(--fg)"><ArrowLeft className="h-4 w-4" /> Back</Link>
      <header className="rounded-2xl border border-(--border) bg-(--surface) p-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <AgentBadge agent={trace.agent} /><StatusPill status={trace.status} abandoned={traceIsAbandoned(trace)} />
          <span>{fmtMs(trace.duration_ms)}</span><span>· {trace.step_count} steps</span><span>· {trace.tool_call_count} tool calls</span><span>· {fmtUsd(trace.cost_estimate_usd)}</span><Thumb thumb={trace.feedback_thumb} />
          <span className="ml-auto text-xs text-(--fg-subtle)">{fmtTime(trace.started_at)} · {trace.turn_id}</span>
        </div>
      </header>
      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <div className="space-y-5">
          <section className="rounded-2xl border border-(--border) bg-(--surface) p-4">
            <h2 className="font-display text-xs font-semibold uppercase tracking-wide text-(--fg-subtle)">What the user asked</h2>
            <p className="mt-1 whitespace-pre-wrap text-sm">{trace.user_input}</p>
            <h2 className="mt-4 font-display text-xs font-semibold uppercase tracking-wide text-(--fg-subtle)">What Navio answered</h2>
            <p className="mt-1 whitespace-pre-wrap text-sm">{trace.final_output || <span className="text-(--fg-subtle)">(no answer)</span>}</p>
          </section>
          {errors.length > 0 && (
            <section className="rounded-2xl border border-[rgba(244,63,94,0.4)] bg-(--surface) p-4"><h2 className="font-display text-sm font-semibold text-(--red)">Errors & warnings</h2>
              <ul className="mt-2 space-y-1 text-sm">{errors.map((e) => <li key={e.id}><span className="font-mono text-xs">{e.level} · {e.type}</span> — {e.message}</li>)}</ul></section>)}
          <Timeline steps={steps} totalMs={trace.duration_ms ?? 0} />
        </div>
        <TraceSidebar trace={trace} prompt={prompt} feedback={feedback} />
      </div>
    </div>
  );
}
```

- [ ] **Step 9: Run** tests + typecheck. Browser: open the FAQ trace (4 cards, expand generate-answer → tokens/cost in Technical details; prompt dialog opens the full prompt), the 3-task partner trace (three lanes under "Split into search tasks", each lane 6 children, `search` shows a candidates table), a failed trace (red pill + error section), keyboard `j`/`k`/`e`/`c`, dark mode, 400 px width (lanes stack).

- [ ] **Step 10: Commit**

```bash
git add app/monitoring/traces components/monitoring tests/monitoring-timeline.test.ts
git commit -m "monitoring: trace detail with step timeline, parallel task lanes, expandable I/O and technical details"
```

---

### Task 14: Session view

**Files:**
- Create: `app/monitoring/sessions/[id]/page.tsx`

- [ ] **Step 1: Write the page**

```tsx
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getSession, traceIsAbandoned } from "@/lib/monitoring/query";
import { AgentBadge, StatusPill, Thumb, fmtMs, fmtTime, fmtUsd } from "@/components/monitoring/ui";
export const dynamic = "force-dynamic";
export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const s = await getSession((await params).id);
  if (!s) notFound();
  return (
    <div className="space-y-5">
      <Link href="/monitoring" className="inline-flex items-center gap-1 text-sm text-(--fg-muted) hover:text-(--fg)"><ArrowLeft className="h-4 w-4" /> Back</Link>
      <header className="rounded-2xl border border-(--border) bg-(--surface) p-4">
        <div className="flex flex-wrap items-center gap-2 text-sm"><AgentBadge agent={s.session.agent} /><span className="font-mono text-xs">{s.session.id}</span>
          <span className="ml-auto text-xs text-(--fg-subtle)">{s.session.turn_count} turns · {fmtTime(s.session.first_seen_at)} → {fmtTime(s.session.last_seen_at)}</span></div>
      </header>
      <ol className="space-y-4">
        {s.traces.map((t) => (
          <li key={t.id} className="space-y-2">
            <div className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-(--user-bubble) px-4 py-2 text-sm text-(--user-bubble-fg)">{t.user_input}</div>
            <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-(--surface-muted) px-4 py-2 text-sm">
              <p className="whitespace-pre-wrap">{t.final_output || <span className="text-(--fg-subtle)">(no answer)</span>}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-(--fg-subtle)">
                <StatusPill status={t.status} abandoned={traceIsAbandoned(t)} /><span>{fmtMs(t.duration_ms)}</span><span>{fmtUsd(t.cost_estimate_usd)}</span><Thumb thumb={t.feedback_thumb} />
                <Link href={`/monitoring/traces/${t.id}`} className="ml-auto font-medium text-(--brand-green) hover:underline">Open trace →</Link>
              </div>
            </div>
          </li>))}
      </ol>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck; open a session link from a trace sidebar** — both turns of a two-turn FAQ conversation appear in order, each linking to its trace.

- [ ] **Step 3: Commit**

```bash
git add app/monitoring/sessions
git commit -m "monitoring: session view (conversation thread, each turn linking to its trace)"
```

---

### Task 15: `monitoring:verify` and `monitoring:reconcile` scripts

**Files:**
- Create: `scripts/monitoring-verify.ts`, `scripts/monitoring-reconcile.ts`
- Modify: `package.json` scripts: `"monitoring:verify": "tsx scripts/monitoring-verify.ts"`, `"monitoring:reconcile": "tsx scripts/monitoring-reconcile.ts"`

**`monitoring-verify.ts`** — end-to-end against a RUNNING widget (`EVE_HOST`, default `http://127.0.0.1:3001`) with the monitoring env in `.env.local`. Flow:
1. FAQ: `new Client({ host }).session().send("Was ist Firmenfitness?")` (like `scripts/live-check.ts`), wait for the result, keep `sessionId`; the turn id is `turn_1`.
2. Partner: `POST ${host}/api/partner/workflow` with `{ message: "Yoga in Bochum", sessionId: "verify-<ts>", turnId: "turn_1" }` (header `origin: host`).
3. Vote 👍 on both via `POST ${host}/api/feedback` (`surface` faq/partner).
4. Sleep 3 s, then read back with `supabaseAdmin()` and assert (each printed as `✓`/`✗`, exit 1 on any ✗):
   - FAQ trace exists for `(sessionId, "turn_1")`, `status === "completed"`, steps in order `request-received, load-knowledge-base, generate-answer, answer-delivered`, every step has non-null `input` or `output`, `generate-answer` has `model`, `tokens_input > 0`, `cost_estimate_usd > 0`, `duration_ms > 0`, `final_output` non-empty, `prompt_version_id` set, feedback row linked with `thumb = up`, `traces.feedback_thumb = up`, `agent_sessions.turn_count >= 1`.
   - Partner trace: `status ∈ {completed, needs_clarification}`, top-level order `request-received, decompose, task, answer-composed`, the `search` child has `tool_name = similarity_search` and an `output.perCity`, `duration_ms > 0`, feedback linked.
   - `--expect-failure`: instead of step 1, send a FAQ turn with `EVE_HOST` pointing at a widget started with a wrong Azure key, and assert `status = failed`, an `errors` row with `type ≠ ""` and a `failure` step.
Shape of the script header mirrors `scripts/verify-langfuse.ts` (`import "../lib/load-env.ts"` first).

**`monitoring-reconcile.ts`** — (1) `update traces set status='failed', metadata = metadata || '{"abandoned":true}' where status='running' and started_at < now() - interval '5 minutes'` via `supabaseAdmin().from("traces").update(...).eq("status","running").lt("started_at", …)` selecting ids, then one `events` insert per id (`trace.abandoned`); (2) `feedback` rows with `trace_id is null` → look up `traces` by `(session_id, turn_id)` → update `trace_id` and refresh `traces.feedback_thumb` (latest row) — print counts. Idempotent; safe to run on a schedule (Vercel cron or GitHub Action later).

- [ ] **Step 1: Write both scripts** as specified (full code, no placeholders — use the assertion helper `check(label: string, ok: boolean)` collecting failures).
- [ ] **Step 2: Run** `npm run monitoring:verify` against the dev widget (V3 on 3008, widget on 3001) — Expected: all ✓. Then `npm run monitoring:reconcile` — Expected: `abandoned: 0, linked: 0` (or the leftover counts).
- [ ] **Step 3: Commit**

```bash
git add scripts/monitoring-verify.ts scripts/monitoring-reconcile.ts package.json
git commit -m "monitoring: end-to-end verify script and reconcile (abandoned traces, unlinked votes)"
```

---

### Task 16: Docs, env example, browser pass

**Files:**
- Create: `docs/MONITORING.md`
- Modify: `.env.example` (variable names + comments only), `CLAUDE.md` (root, gitignored — add a §17 pointer), `kb-agent-langsmith-starter/CLAUDE.md` if it lists `lib/` modules

- [ ] **Step 1: `.env.example`** — append:

```
# --- Agent monitoring (Supabase, separate project) — docs/MONITORING.md ---
# All blank ⇒ monitoring is a silent no-op and /monitoring returns 404.
MONITORING_SUPABASE_URL=
MONITORING_SUPABASE_SERVICE_ROLE_KEY=
# Dashboard login (shared password) + cookie signing key (>= 32 random bytes, e.g. `openssl rand -hex 32`).
MONITORING_PASSWORD=
MONITORING_COOKIE_SECRET=
# Optional label stored on every trace; defaults to VERCEL_ENV, then NODE_ENV.
MONITORING_ENVIRONMENT=
```

- [ ] **Step 2: `docs/MONITORING.md`** — sections: What it is (one paragraph + the question chain from the spec §1) · Architecture (capture paths, RPC, dashboard; the ASCII diagram) · Data model (table per table, one line each; step mapping tables copied from the spec §4) · Setup (create Supabase project, apply the two migrations with the MCP or SQL editor, env vars, Vercel env + redeploy) · Using the dashboard (login, overview, filters, trace detail, keyboard, session view, dark mode) · Feedback (both surfaces, unlinked votes, reconcile) · Operations (`monitoring:verify`, `monitoring:reconcile`, abandoned traces, what "never throws" means, log lines to grep: `[monitoring]`, `MONITORING feedback:`) · Invariants (the five from the spec) · Known limits (partner votes still 502 on the Langfuse forward; `turn_unknown` rows; no retention policy yet; middleware file is `middleware.ts` on Next 15.5).

- [ ] **Step 3: Root `CLAUDE.md`** — add `## 17. Agent monitoring (Supabase) — see kb-agent-langsmith-starter/docs/MONITORING.md` with 6 bullet facts: where the code lives, the RPC-merge design, the FAQ hook is incremental, V3 usage is additive, password unset ⇒ 404, `middleware.ts` not `proxy.ts`.

- [ ] **Step 4: Browser pass** with the `browse` skill on `http://127.0.0.1:3001/monitoring`: login → overview → filter `agent=partner` → open a 3-task trace → expand/collapse + `j`/`k` → open a failed trace → session view → dark mode → 400 px viewport screenshot. Fix anything that breaks; record findings in the final report.

- [ ] **Step 5: Final regression** — widget: `npm test`, `npm run typecheck`, `npm run langfuse:verify <faq session id from verify>`; V3: `npm test`, `npm run typecheck`.

- [ ] **Step 6: Commit**

```bash
git add docs/MONITORING.md .env.example
git commit -m "docs: agent monitoring manual and env example"
```

---

## Self-review notes

- Spec coverage: §4 tables → T1; RPC + stats → T2; §5 module files → T3/T4/T6/T7/T8/T9 (`describe.ts`, `pricing.ts`, `env.ts`, `types.ts`, `store.ts`, `v3-mapper.ts`, `faq-mapper.ts`, `feedback.ts`); FAQ hook → T8; partner adapter + widget ids → T7; V3 usage → T5; §6 feedback → T9; §7 auth/middleware/API → T10/T11; screens → T12/T13/T14; §8 config → T3/T16; §9 tests → each task + T15; §10 order preserved.
- Deviations from the spec, deliberate: `middleware.ts` instead of `proxy.ts` (Next 15.5); `trace_steps.step_key/parent_key` added so partial writes can upsert; `errors.level = warning` rows are also used for stage warnings (spec's `warning_count` needs a source); the partner write is awaited with a 5 s cap rather than detached (a detached promise dies with the serverless invocation).
- Type consistency: `TraceDraft.trace` fields = `TraceFields` (T3) used by both mappers; `StepDraft.step_key` is the RPC upsert key (T2); `MonitoringStore` (T4) is the only writer used by T7/T8/T9; `StepNode` (T11) feeds T13.
