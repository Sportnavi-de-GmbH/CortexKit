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
