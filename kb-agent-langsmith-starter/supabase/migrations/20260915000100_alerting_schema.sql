-- Navio alerting — schema + metrics RPCs (spec docs/superpowers/specs/2026-09-15-navio-alerting-design.md §4)

create table if not exists alert_rules (
  id uuid primary key default gen_random_uuid(),
  key text not null check (key in ('cost_daily','cost_spike','failure_rate','latency_p95','negative_feedback','error_repeat','partner_upstream')),
  agent text not null default 'all' check (agent in ('all','faq','partner')),
  enabled boolean not null default true,
  severity text not null default 'alert' check (severity in ('warning','alert')),
  threshold numeric not null,
  window_hours int not null,
  min_samples int not null default 0,
  params jsonb not null default '{}'::jsonb,
  description text not null default '',
  updated_at timestamptz not null default now(),
  unique (key, agent)
);

create table if not exists alert_state (
  rule_id uuid not null references alert_rules(id) on delete cascade,
  agent text not null,
  subkey text not null default '',
  status text not null check (status in ('ok','breached','error')),
  observed numeric,
  samples int,
  last_evaluated_at timestamptz not null,
  last_transition_at timestamptz,
  primary key (rule_id, agent, subkey)
);

create table if not exists alert_events (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('fired','recovered','digest','test')),
  rule_key text,
  agent text,
  subkey text not null default '',
  severity text,
  observed numeric,
  threshold numeric,
  samples int,
  window_hours int,
  window_from timestamptz,
  window_to timestamptz,
  narrative text not null,
  narrative_source text not null check (narrative_source in ('llm','template')),
  delivery jsonb not null default '{}'::jsonb,
  run_slot text not null,
  acknowledged_by text,
  acknowledged_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists alert_events_created_idx on alert_events (created_at desc);
create unique index if not exists alert_events_digest_slot_idx on alert_events (run_slot) where kind = 'digest';

create table if not exists alert_settings (
  id int primary key default 1 check (id = 1),
  email_recipients text[] not null default '{}',
  digest_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);
insert into alert_settings (id) values (1) on conflict (id) do nothing;

alter table alert_rules enable row level security;
alter table alert_state enable row level security;
alter table alert_events enable row level security;
alter table alert_settings enable row level security;

-- Seed (spec §4 table). ON CONFLICT so re-applying never resets edited thresholds.
insert into alert_rules (key, agent, severity, threshold, window_hours, min_samples, params, description) values
  ('cost_daily',        'all',     'alert',   2.00,  24,  0,  '{"per_agent_usd":1.5,"window":"berlin_day"}', 'Kosten heute (Berlin) über Limit'),
  ('cost_spike',        'all',     'warning', 3.0,   24,  0,  '{"min_abs_usd":0.5,"baseline_days":7}',       'Kosten der letzten 24 h vs. 7-Tage-Basis'),
  ('failure_rate',      'all',     'alert',   0.10,  24,  10, '{}',                                           'Anteil fehlgeschlagener/abgebrochener Turns'),
  ('latency_p95',       'faq',     'warning', 8000,  24,  10, '{}',                                           'p95 Antwortzeit FAQ'),
  ('latency_p95',       'partner', 'warning', 60000, 24,  10, '{}',                                           'p95 Antwortzeit Partner'),
  ('negative_feedback', 'all',     'warning', 0.30,  168, 5,  '{}',                                           'Anteil 👎 an bewerteten Antworten'),
  ('error_repeat',      'all',     'warning', 5,     24,  0,  '{}',                                           'Gleicher Fehlertyp wiederholt'),
  ('partner_upstream',  'partner', 'alert',   3,     24,  0,  '{"error_type":"upstream_unavailable"}',        'Partner-Agent nicht erreichbar')
on conflict (key, agent) do nothing;

-- Per-window aggregates per agent + total. Production only via p_env.
create or replace function monitoring_alert_window(p_env text, p_hours int) returns jsonb
language sql security definer set search_path = public stable as $$
  with w as (
    select * from traces
    where started_at >= now() - make_interval(hours => p_hours)
      and coalesce(metadata->>'env', '') = p_env),
  agg as (
    select agent,
      count(*) as traces,
      count(*) filter (where status = 'failed') as failed,
      count(*) filter (where status = 'running' and started_at < now() - interval '5 minutes') as abandoned,
      coalesce(sum(cost_estimate_usd), 0) as cost_usd,
      percentile_cont(0.95) within group (order by duration_ms) as p95_ms,
      count(*) filter (where feedback_thumb is not null) as rated,
      count(*) filter (where feedback_thumb = 'down') as down
    from w group by agent),
  errs as (
    select t.agent, e.type, count(*) as n
    from errors e join traces t on t.id = e.trace_id
    where e.level = 'error' and t.id in (select id from w)
    group by t.agent, e.type),
  per_agent as (
    select a.agent, jsonb_build_object(
      'traces', a.traces, 'failed', a.failed, 'abandoned', a.abandoned,
      'cost_usd', a.cost_usd, 'p95_ms', round(a.p95_ms), 'rated', a.rated, 'down', a.down,
      'error_types', coalesce((select jsonb_agg(jsonb_build_object('type', type, 'n', n)) from errs where errs.agent = a.agent), '[]'::jsonb)
    ) as j from agg a),
  total as (
    select jsonb_build_object(
      'traces', coalesce(sum(traces),0), 'failed', coalesce(sum(failed),0), 'abandoned', coalesce(sum(abandoned),0),
      'cost_usd', coalesce(sum(cost_usd),0),
      'p95_ms', (select round(percentile_cont(0.95) within group (order by duration_ms)) from w),
      'rated', coalesce(sum(rated),0), 'down', coalesce(sum(down),0),
      'error_types', coalesce((select jsonb_agg(jsonb_build_object('type', type, 'n', n)) from (select type, sum(n) as n from errs group by type) s), '[]'::jsonb)
    ) as j from agg)
  select jsonb_build_object(
    'faq', coalesce((select j from per_agent where agent = 'faq'), '{"traces":0,"failed":0,"abandoned":0,"cost_usd":0,"p95_ms":null,"rated":0,"down":0,"error_types":[]}'::jsonb),
    'partner', coalesce((select j from per_agent where agent = 'partner'), '{"traces":0,"failed":0,"abandoned":0,"cost_usd":0,"p95_ms":null,"rated":0,"down":0,"error_types":[]}'::jsonb),
    'total', (select j from total));
$$;

-- Cost since local midnight in p_tz, and the mean daily cost of the previous p_baseline_days full local days.
create or replace function monitoring_alert_cost_day(p_env text, p_tz text, p_baseline_days int) returns jsonb
language sql security definer set search_path = public stable as $$
  with t as (
    select agent, cost_estimate_usd, (started_at at time zone p_tz)::date as d
    from traces where coalesce(metadata->>'env','') = p_env
      and started_at >= (date_trunc('day', now() at time zone p_tz) - make_interval(days => p_baseline_days)) at time zone p_tz),
  today as (select agent, sum(cost_estimate_usd) as c from t where d = (now() at time zone p_tz)::date group by agent),
  base as (select agent, d, sum(cost_estimate_usd) as c from t where d < (now() at time zone p_tz)::date group by agent, d),
  base_days as (select count(distinct d) as n from base)
  select jsonb_build_object(
    'today', jsonb_build_object(
      'faq', coalesce((select c from today where agent='faq'),0),
      'partner', coalesce((select c from today where agent='partner'),0),
      'total', coalesce((select sum(c) from today),0)),
    'baseline_days', (select n from base_days),
    'baseline_avg', jsonb_build_object(
      'faq', coalesce((select sum(c) from base where agent='faq'),0) / greatest((select n from base_days),1),
      'partner', coalesce((select sum(c) from base where agent='partner'),0) / greatest((select n from base_days),1),
      'total', coalesce((select sum(c) from base),0) / greatest((select n from base_days),1)));
$$;

revoke all on function monitoring_alert_window(text, int) from public, anon, authenticated;
revoke all on function monitoring_alert_cost_day(text, text, int) from public, anon, authenticated;
