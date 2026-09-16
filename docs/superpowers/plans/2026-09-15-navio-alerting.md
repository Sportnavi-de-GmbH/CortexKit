# Navio Alerting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Threshold alerts computed from the Supabase monitoring tables, scheduled by pg_cron, delivered to Teams + email with LLM-written text, visible and editable on `/monitoring/alerts`.

**Architecture:** Pure rule functions (`lib/monitoring/alerts/rules.ts`) evaluate metrics that two small SQL RPCs return; `evaluate.ts` diffs against `alert_state`, writes `alert_events`, and delivers through the existing `teams.ts` / `graph-mail.ts` senders. pg_cron + pg_net in the monitoring Supabase project POST to `/api/monitoring/alerts/evaluate` with a bearer secret. Dashboard routes are cookie-gated like the rest of `/monitoring`.

**Tech Stack:** Next 15 (app router, node runtime), TypeScript, `@supabase/supabase-js`, `ai` v7 `generateText` via `lib/llm.ts`, zod 4, vitest, Postgres (pg_cron 1.6, pg_net 0.20, Vault).

**Spec:** `docs/superpowers/specs/2026-09-15-navio-alerting-design.md`

## Global Constraints

- All paths below are relative to `kb-agent-langsmith-starter/` unless they start with `docs/superpowers/` or `SportnaviPartnerRecomandationBot/`.
- Missing config ⇒ silent no-op, never a throw (repo rule; mirrors `lib/monitoring/store.ts`).
- Production traffic only: `traces.metadata->>'env' = 'production'` (parameter `p_env`; the live check passes `'production'` and tags its throwaway traces the same way).
- vitest has **no JSX transform**: all testable logic lives in `.ts` files, never `.tsx`.
- Dashboard UI reuses `components/monitoring/ui.tsx` primitives, lucide icons only, responsive 375–1440, dark mode.
- Commit messages: **no** `Co-Authored-By` / Anthropic trailer (CLAUDE.md §13 overrides the harness default).
- Before each commit: `npm run typecheck` and `npm test` green.
- Never commit `.env.local` or a real secret. Vault secrets are created by hand, never in migration text.
- Narrative language: German. The LLM never decides whether something is an alert.
- Colour rule: green = OK / AI, orange = human hand-off, red = breach. No new brand colour.

---

### Task 1: Migration — alert tables, seed, metrics RPCs

**Files:**
- Create: `supabase/migrations/20260915000100_alerting_schema.sql`
- Modify: `docs/MONITORING.md` (§3 Setup, step 1: add the new migration to the list)

**Interfaces:**
- Produces tables `alert_rules`, `alert_state`, `alert_events`, `alert_settings` exactly as in spec §4.
- Produces RPC `monitoring_alert_window(p_env text, p_hours int) returns jsonb` with shape
  `{"faq": W, "partner": W, "total": W}` where `W = {traces, failed, abandoned, cost_usd, p95_ms, rated, down, error_types: [{type, n}]}`.
- Produces RPC `monitoring_alert_cost_day(p_env text, p_tz text, p_baseline_days int) returns jsonb` with shape
  `{"today": {faq, partner, total}, "baseline_days": n, "baseline_avg": {faq, partner, total}}`.

- [ ] **Step 1: Write the migration**

```sql
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
```

- [ ] **Step 2: Apply it to the monitoring project**

Use the Supabase MCP `mcp__supabase-monitoring__apply_migration` with `name: "alerting_schema"` and the file content, or paste into the SQL editor.

- [ ] **Step 3: Verify with SQL**

Run via `mcp__supabase-monitoring__execute_sql`:

```sql
select count(*) from alert_rules;                                   -- 8
select monitoring_alert_window('production', 24)->'total'->>'traces';  -- a number (may be 0)
select monitoring_alert_cost_day('production', 'Europe/Berlin', 7)->>'baseline_days';  -- a number
```

Expected: 8 rows, then two numeric strings; no errors.

- [ ] **Step 4: Update docs/MONITORING.md §3 step 1** to read: apply `…000100_monitoring_schema.sql`, `…000200_monitoring_rpc.sql`, then `…20260915000100_alerting_schema.sql`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260915000100_alerting_schema.sql docs/MONITORING.md
git commit -m "alerting: schema, seeded rules, and metrics RPCs"
```

---

### Task 2: Types and pure rule evaluation

**Files:**
- Create: `lib/monitoring/alerts/types.ts`
- Create: `lib/monitoring/alerts/rules.ts`
- Test: `tests/alerts-rules.test.ts`

**Interfaces:**
- Produces (types.ts):
  ```ts
  export type RuleKey = "cost_daily"|"cost_spike"|"failure_rate"|"latency_p95"|"negative_feedback"|"error_repeat"|"partner_upstream";
  export type RuleAgent = "all"|"faq"|"partner";
  export type ObsAgent = "faq"|"partner"|"total";
  export interface AlertRule { id: string; key: RuleKey; agent: RuleAgent; enabled: boolean; severity: "warning"|"alert"; threshold: number; window_hours: number; min_samples: number; params: Record<string, unknown>; description: string; }
  export interface WindowAgg { traces: number; failed: number; abandoned: number; cost_usd: number; p95_ms: number|null; rated: number; down: number; error_types: { type: string; n: number }[] }
  export interface WindowMetrics { faq: WindowAgg; partner: WindowAgg; total: WindowAgg }
  export interface CostDay { today: Record<ObsAgent, number>; baseline_days: number; baseline_avg: Record<ObsAgent, number> }
  export interface MetricsInput { windows: Record<number, WindowMetrics>; costDay: CostDay }
  export type ObsStatus = "ok"|"breached"|"skipped";
  export interface Observation { rule: AlertRule; agent: ObsAgent; subkey: string; status: ObsStatus; observed: number|null; samples: number; threshold: number; note?: string }
  ```
- Produces (rules.ts): `evaluateRule(rule: AlertRule, m: MetricsInput): Observation[]` and `evaluateAll(rules: AlertRule[], m: MetricsInput): Observation[]`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/alerts-rules.test.ts
import { describe, it, expect } from "vitest";
import { evaluateRule } from "../lib/monitoring/alerts/rules";
import type { AlertRule, MetricsInput, WindowAgg } from "../lib/monitoring/alerts/types";

const agg = (o: Partial<WindowAgg> = {}): WindowAgg => ({
  traces: 0, failed: 0, abandoned: 0, cost_usd: 0, p95_ms: null, rated: 0, down: 0, error_types: [], ...o,
});
const rule = (o: Partial<AlertRule>): AlertRule => ({
  id: "r1", key: "failure_rate", agent: "all", enabled: true, severity: "alert",
  threshold: 0.1, window_hours: 24, min_samples: 10, params: {}, description: "", ...o,
});
const metrics = (w24: Partial<Record<"faq"|"partner"|"total", WindowAgg>>, costDay?: MetricsInput["costDay"]): MetricsInput => ({
  windows: { 24: { faq: w24.faq ?? agg(), partner: w24.partner ?? agg(), total: w24.total ?? agg() }, 168: { faq: agg(), partner: agg(), total: agg() } },
  costDay: costDay ?? { today: { faq: 0, partner: 0, total: 0 }, baseline_days: 0, baseline_avg: { faq: 0, partner: 0, total: 0 } },
});

describe("failure_rate", () => {
  it("breaches above threshold with enough samples, counting abandoned as failed", () => {
    const obs = evaluateRule(rule({}), metrics({ total: agg({ traces: 20, failed: 2, abandoned: 1 }), faq: agg({ traces: 20, failed: 2, abandoned: 1 }) }));
    const total = obs.find((o) => o.agent === "total")!;
    expect(total.status).toBe("breached");
    expect(total.observed).toBeCloseTo(0.15);
    expect(total.samples).toBe(20);
  });
  it("skips below min_samples", () => {
    const obs = evaluateRule(rule({}), metrics({ total: agg({ traces: 2, failed: 1 }) }));
    expect(obs.find((o) => o.agent === "total")!.status).toBe("skipped");
  });
  it("agent='all' yields faq, partner and total observations", () => {
    expect(evaluateRule(rule({}), metrics({})).map((o) => o.agent).sort()).toEqual(["faq", "partner", "total"]);
  });
  it("agent='faq' yields only faq", () => {
    expect(evaluateRule(rule({ agent: "faq" }), metrics({})).map((o) => o.agent)).toEqual(["faq"]);
  });
});

describe("latency_p95", () => {
  it("breaches at > threshold, ok at threshold", () => {
    const r = rule({ key: "latency_p95", agent: "faq", threshold: 8000, min_samples: 10 });
    expect(evaluateRule(r, metrics({ faq: agg({ traces: 12, p95_ms: 8001 }) }))[0].status).toBe("breached");
    expect(evaluateRule(r, metrics({ faq: agg({ traces: 12, p95_ms: 8000 }) }))[0].status).toBe("ok");
  });
});

describe("cost_daily", () => {
  it("total uses threshold, agents use params.per_agent_usd", () => {
    const r = rule({ key: "cost_daily", threshold: 2, min_samples: 0, params: { per_agent_usd: 1.5 } });
    const obs = evaluateRule(r, metrics({}, { today: { faq: 1.6, partner: 0.1, total: 1.7 }, baseline_days: 0, baseline_avg: { faq: 0, partner: 0, total: 0 } }));
    expect(obs.find((o) => o.agent === "faq")!.status).toBe("breached");
    expect(obs.find((o) => o.agent === "faq")!.threshold).toBe(1.5);
    expect(obs.find((o) => o.agent === "total")!.status).toBe("ok");
  });
});

describe("cost_spike", () => {
  const r = rule({ key: "cost_spike", severity: "warning", threshold: 3, min_samples: 0, params: { min_abs_usd: 0.5, baseline_days: 7 } });
  it("skipped while warming up (fewer baseline days than configured)", () => {
    const obs = evaluateRule(r, metrics({ total: agg({ cost_usd: 5 }) }, { today: { faq: 0, partner: 0, total: 0 }, baseline_days: 3, baseline_avg: { faq: 0, partner: 0, total: 1 } }));
    expect(obs.find((o) => o.agent === "total")!.status).toBe("skipped");
    expect(obs.find((o) => o.agent === "total")!.note).toMatch(/warm/i);
  });
  it("breaches when 24h cost > 3x baseline and > min_abs_usd", () => {
    const obs = evaluateRule(r, metrics({ total: agg({ cost_usd: 4 }) }, { today: { faq: 0, partner: 0, total: 0 }, baseline_days: 7, baseline_avg: { faq: 0, partner: 0, total: 1 } }));
    const t = obs.find((o) => o.agent === "total")!;
    expect(t.status).toBe("breached");
    expect(t.observed).toBe(4); // multiplier
  });
  it("never fires below min_abs_usd even at a huge multiplier", () => {
    const obs = evaluateRule(r, metrics({ total: agg({ cost_usd: 0.4 }) }, { today: { faq: 0, partner: 0, total: 0 }, baseline_days: 7, baseline_avg: { faq: 0, partner: 0, total: 0.01 } }));
    expect(obs.find((o) => o.agent === "total")!.status).toBe("ok");
  });
});

describe("negative_feedback", () => {
  it("uses the 168h window and min votes", () => {
    const r = rule({ key: "negative_feedback", threshold: 0.3, window_hours: 168, min_samples: 5 });
    const m = metrics({});
    m.windows[168].total = agg({ rated: 6, down: 2 });
    expect(evaluateRule(r, m).find((o) => o.agent === "total")!.status).toBe("breached");
    m.windows[168].total = agg({ rated: 4, down: 4 });
    expect(evaluateRule(r, m).find((o) => o.agent === "total")!.status).toBe("skipped");
  });
});

describe("error_repeat / partner_upstream", () => {
  it("one observation per error type, ignoring upstream_unavailable", () => {
    const r = rule({ key: "error_repeat", threshold: 5, min_samples: 0 });
    const obs = evaluateRule(r, metrics({ total: agg({ error_types: [{ type: "azure_429", n: 6 }, { type: "upstream_unavailable", n: 9 }, { type: "tool_error", n: 1 }] }) }));
    const totals = obs.filter((o) => o.agent === "total");
    expect(totals.map((o) => o.subkey).sort()).toEqual(["azure_429", "tool_error"]);
    expect(totals.find((o) => o.subkey === "azure_429")!.status).toBe("breached");
    expect(totals.find((o) => o.subkey === "tool_error")!.status).toBe("ok");
  });
  it("partner_upstream counts the configured error type on partner", () => {
    const r = rule({ key: "partner_upstream", agent: "partner", threshold: 3, min_samples: 0, params: { error_type: "upstream_unavailable" } });
    const obs = evaluateRule(r, metrics({ partner: agg({ error_types: [{ type: "upstream_unavailable", n: 3 }] }) }));
    expect(obs[0].status).toBe("breached");
    expect(obs[0].observed).toBe(3);
  });
});

describe("robustness", () => {
  it("a missing window yields skipped, not a throw", () => {
    const r = rule({ window_hours: 48 });
    const obs = evaluateRule(r, metrics({}));
    expect(obs.every((o) => o.status === "skipped")).toBe(true);
  });
  it("disabled rules produce nothing", () => {
    expect(evaluateRule(rule({ enabled: false }), metrics({}))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/alerts-rules.test.ts`
Expected: FAIL — cannot resolve `../lib/monitoring/alerts/rules`.

- [ ] **Step 3: Write types.ts**

```ts
// lib/monitoring/alerts/types.ts — shared shapes for the alerting layer (spec §4–§6).
export type RuleKey =
  | "cost_daily" | "cost_spike" | "failure_rate" | "latency_p95"
  | "negative_feedback" | "error_repeat" | "partner_upstream";
export type RuleAgent = "all" | "faq" | "partner";
export type ObsAgent = "faq" | "partner" | "total";
export type Severity = "warning" | "alert";

export interface AlertRule {
  id: string;
  key: RuleKey;
  agent: RuleAgent;
  enabled: boolean;
  severity: Severity;
  threshold: number;
  window_hours: number;
  min_samples: number;
  params: Record<string, unknown>;
  description: string;
}

export interface WindowAgg {
  traces: number; failed: number; abandoned: number; cost_usd: number;
  p95_ms: number | null; rated: number; down: number;
  error_types: { type: string; n: number }[];
}
export interface WindowMetrics { faq: WindowAgg; partner: WindowAgg; total: WindowAgg }
export interface CostDay {
  today: Record<ObsAgent, number>;
  baseline_days: number;
  baseline_avg: Record<ObsAgent, number>;
}
export interface MetricsInput { windows: Record<number, WindowMetrics>; costDay: CostDay }

export type ObsStatus = "ok" | "breached" | "skipped";
export interface Observation {
  rule: AlertRule;
  agent: ObsAgent;
  subkey: string;
  status: ObsStatus;
  observed: number | null;
  samples: number;
  threshold: number;
  note?: string;
}

/** Row of alert_state as stored. */
export interface AlertStateRow {
  rule_id: string; agent: string; subkey: string;
  status: "ok" | "breached" | "error";
  observed: number | null; samples: number | null;
  last_evaluated_at: string; last_transition_at: string | null;
}

export type EventKind = "fired" | "recovered" | "digest" | "test";
export interface Transition {
  kind: "fired" | "recovered";
  obs: Observation;
}
```

- [ ] **Step 4: Write rules.ts**

```ts
// lib/monitoring/alerts/rules.ts — PURE. Decides ok/breached/skipped from metrics; no I/O.
// The LLM never touches this: honesty invariant (spec §6).
import type { AlertRule, MetricsInput, ObsAgent, Observation, WindowAgg } from "./types";

const AGENTS: ObsAgent[] = ["faq", "partner", "total"];

function targets(rule: AlertRule): ObsAgent[] {
  return rule.agent === "all" ? AGENTS : [rule.agent];
}
function num(v: unknown, fallback: number): number {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}
function str(v: unknown, fallback: string): string {
  return typeof v === "string" && v ? v : fallback;
}
function obs(rule: AlertRule, agent: ObsAgent, o: Omit<Observation, "rule" | "agent" | "subkey"> & { subkey?: string }): Observation {
  return { rule, agent, subkey: o.subkey ?? "", status: o.status, observed: o.observed, samples: o.samples, threshold: o.threshold, ...(o.note ? { note: o.note } : {}) };
}
function skipped(rule: AlertRule, agent: ObsAgent, note: string, threshold = rule.threshold): Observation {
  return obs(rule, agent, { status: "skipped", observed: null, samples: 0, threshold, note });
}
function ratio(rule: AlertRule, agent: ObsAgent, numer: number, denom: number): Observation {
  if (denom < Math.max(rule.min_samples, 1)) return skipped(rule, agent, `zu wenig Daten (${denom} < ${rule.min_samples})`);
  const value = numer / denom;
  return obs(rule, agent, { status: value > rule.threshold ? "breached" : "ok", observed: value, samples: denom, threshold: rule.threshold });
}

export function evaluateRule(rule: AlertRule, m: MetricsInput): Observation[] {
  if (!rule.enabled) return [];
  const win = m.windows[rule.window_hours];
  const out: Observation[] = [];

  for (const agent of targets(rule)) {
    const w: WindowAgg | undefined = win?.[agent];

    switch (rule.key) {
      case "failure_rate": {
        if (!w) { out.push(skipped(rule, agent, "Fenster nicht geladen")); break; }
        out.push(ratio(rule, agent, w.failed + w.abandoned, w.traces));
        break;
      }
      case "latency_p95": {
        if (!w) { out.push(skipped(rule, agent, "Fenster nicht geladen")); break; }
        if (w.traces < rule.min_samples || w.p95_ms === null) { out.push(skipped(rule, agent, `zu wenig Daten (${w.traces} < ${rule.min_samples})`)); break; }
        out.push(obs(rule, agent, { status: w.p95_ms > rule.threshold ? "breached" : "ok", observed: w.p95_ms, samples: w.traces, threshold: rule.threshold }));
        break;
      }
      case "negative_feedback": {
        if (!w) { out.push(skipped(rule, agent, "Fenster nicht geladen")); break; }
        out.push(ratio(rule, agent, w.down, w.rated));
        break;
      }
      case "cost_daily": {
        const threshold = agent === "total" ? rule.threshold : num(rule.params.per_agent_usd, rule.threshold);
        const today = num(m.costDay.today[agent], 0);
        out.push(obs(rule, agent, { status: today > threshold ? "breached" : "ok", observed: today, samples: 0, threshold }));
        break;
      }
      case "cost_spike": {
        const baselineDays = num(rule.params.baseline_days, 7);
        const minAbs = num(rule.params.min_abs_usd, 0.5);
        if (m.costDay.baseline_days < baselineDays) { out.push(skipped(rule, agent, `Aufwärmphase: ${m.costDay.baseline_days}/${baselineDays} Tage Basis`)); break; }
        if (!w) { out.push(skipped(rule, agent, "Fenster nicht geladen")); break; }
        const base = num(m.costDay.baseline_avg[agent], 0);
        const last24 = num(w.cost_usd, 0);
        const multiplier = base > 0 ? last24 / base : (last24 > 0 ? Infinity : 0);
        const breached = last24 > minAbs && multiplier > rule.threshold;
        out.push(obs(rule, agent, { status: breached ? "breached" : "ok", observed: Number.isFinite(multiplier) ? multiplier : 999, samples: 0, threshold: rule.threshold, note: `24h ${last24.toFixed(2)} $ vs Basis ${base.toFixed(2)} $/Tag` }));
        break;
      }
      case "error_repeat": {
        if (!w) { out.push(skipped(rule, agent, "Fenster nicht geladen")); break; }
        for (const e of w.error_types) {
          if (e.type === "upstream_unavailable") continue; // owned by partner_upstream
          out.push(obs(rule, agent, { subkey: e.type, status: e.n >= rule.threshold ? "breached" : "ok", observed: e.n, samples: e.n, threshold: rule.threshold }));
        }
        break;
      }
      case "partner_upstream": {
        if (!w) { out.push(skipped(rule, agent, "Fenster nicht geladen")); break; }
        const type = str(rule.params.error_type, "upstream_unavailable");
        const n = w.error_types.find((e) => e.type === type)?.n ?? 0;
        out.push(obs(rule, agent, { status: n >= rule.threshold ? "breached" : "ok", observed: n, samples: n, threshold: rule.threshold }));
        break;
      }
    }
  }
  return out;
}

export function evaluateAll(rules: AlertRule[], m: MetricsInput): Observation[] {
  return rules.flatMap((r) => evaluateRule(r, m));
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/alerts-rules.test.ts`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/monitoring/alerts/types.ts lib/monitoring/alerts/rules.ts tests/alerts-rules.test.ts
git commit -m "alerting: pure rule evaluation over window metrics"
```

---

### Task 3: State diffing and run slots

**Files:**
- Create: `lib/monitoring/alerts/state.ts`
- Test: `tests/alerts-state.test.ts`

**Interfaces:**
- Produces `diffStates(prev: AlertStateRow[], obs: Observation[], nowIso: string): { transitions: Transition[]; next: AlertStateRow[] }`.
- Produces `runSlot(slot: "scheduled"|"test"|"manual", now: Date, tz?: string): string` and `berlinParts(now: Date, tz?: string): { date: string; hour: string; minute: string }`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/alerts-state.test.ts
import { describe, it, expect } from "vitest";
import { diffStates, runSlot } from "../lib/monitoring/alerts/state";
import type { AlertRule, AlertStateRow, Observation } from "../lib/monitoring/alerts/types";

const rule: AlertRule = { id: "r1", key: "failure_rate", agent: "all", enabled: true, severity: "alert", threshold: 0.1, window_hours: 24, min_samples: 10, params: {}, description: "" };
const o = (status: Observation["status"], agent: Observation["agent"] = "total", subkey = ""): Observation =>
  ({ rule, agent, subkey, status, observed: 0.2, samples: 20, threshold: 0.1 });
const prev = (status: AlertStateRow["status"], agent = "total", subkey = ""): AlertStateRow =>
  ({ rule_id: "r1", agent, subkey, status, observed: 0.05, samples: 20, last_evaluated_at: "2026-09-15T05:00:00Z", last_transition_at: null });
const NOW = "2026-09-15T13:00:00Z";

describe("diffStates", () => {
  it("absent → breached fires", () => {
    const { transitions, next } = diffStates([], [o("breached")], NOW);
    expect(transitions).toEqual([{ kind: "fired", obs: o("breached") }]);
    expect(next[0]).toMatchObject({ status: "breached", last_transition_at: NOW, last_evaluated_at: NOW });
  });
  it("ok → breached fires; breached → breached is silent", () => {
    expect(diffStates([prev("ok")], [o("breached")], NOW).transitions).toHaveLength(1);
    expect(diffStates([prev("breached")], [o("breached")], NOW).transitions).toHaveLength(0);
  });
  it("breached → ok recovers; ok → ok silent; absent → ok silent", () => {
    expect(diffStates([prev("breached")], [o("ok")], NOW).transitions[0].kind).toBe("recovered");
    expect(diffStates([prev("ok")], [o("ok")], NOW).transitions).toHaveLength(0);
    expect(diffStates([], [o("ok")], NOW).transitions).toHaveLength(0);
  });
  it("skipped keeps the previous status and never transitions", () => {
    const r = diffStates([prev("breached")], [o("skipped")], NOW);
    expect(r.transitions).toHaveLength(0);
    expect(r.next[0].status).toBe("breached");
  });
  it("subkeys are independent", () => {
    const r = diffStates([prev("breached", "total", "azure_429")], [o("breached", "total", "azure_429"), o("breached", "total", "tool_error")], NOW);
    expect(r.transitions.map((t) => t.obs.subkey)).toEqual(["tool_error"]);
  });
  it("keeps last_transition_at when unchanged", () => {
    const p = { ...prev("ok"), last_transition_at: "2026-09-01T00:00:00Z" };
    expect(diffStates([p], [o("ok")], NOW).next[0].last_transition_at).toBe("2026-09-01T00:00:00Z");
  });
});

describe("runSlot", () => {
  it("scheduled = Berlin hour; test/manual = Berlin minute", () => {
    const d = new Date("2026-09-15T05:07:30Z"); // 07:07 CEST
    expect(runSlot("scheduled", d)).toBe("2026-09-15T07");
    expect(runSlot("test", d)).toBe("test:2026-09-15T07:07");
    expect(runSlot("manual", d)).toBe("manual:2026-09-15T07:07");
  });
  it("winter time shifts by one hour", () => {
    expect(runSlot("scheduled", new Date("2026-12-15T06:00:00Z"))).toBe("2026-12-15T07");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/alerts-state.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Write state.ts**

```ts
// lib/monitoring/alerts/state.ts — PURE transition logic + run-slot naming (spec §5).
import type { AlertStateRow, Observation, Transition } from "./types";

const keyOf = (ruleId: string, agent: string, subkey: string) => `${ruleId}|${agent}|${subkey}`;

export function diffStates(prev: AlertStateRow[], obs: Observation[], nowIso: string): { transitions: Transition[]; next: AlertStateRow[] } {
  const before = new Map(prev.map((p) => [keyOf(p.rule_id, p.agent, p.subkey), p]));
  const transitions: Transition[] = [];
  const next: AlertStateRow[] = [];

  for (const o of obs) {
    const k = keyOf(o.rule.id, o.agent, o.subkey);
    const p = before.get(k);
    const wasBreached = p?.status === "breached";
    let status: AlertStateRow["status"] = o.status === "skipped" ? (p?.status ?? "ok") : o.status;
    let transitionAt = p?.last_transition_at ?? null;

    if (o.status === "breached" && !wasBreached) { transitions.push({ kind: "fired", obs: o }); transitionAt = nowIso; status = "breached"; }
    else if (o.status === "ok" && wasBreached) { transitions.push({ kind: "recovered", obs: o }); transitionAt = nowIso; status = "ok"; }

    next.push({
      rule_id: o.rule.id, agent: o.agent, subkey: o.subkey, status,
      observed: o.status === "skipped" ? (p?.observed ?? null) : o.observed,
      samples: o.status === "skipped" ? (p?.samples ?? null) : o.samples,
      last_evaluated_at: nowIso, last_transition_at: transitionAt,
    });
  }
  return { transitions, next };
}

export function berlinParts(now: Date, tz = "Europe/Berlin"): { date: string; hour: string; minute: string } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(now)
    .reduce<Record<string, string>>((acc, p) => (p.type !== "literal" ? { ...acc, [p.type]: p.value } : acc), {});
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: parts.hour === "24" ? "00" : parts.hour, minute: parts.minute };
}

export function runSlot(slot: "scheduled" | "test" | "manual", now: Date, tz = "Europe/Berlin"): string {
  const { date, hour, minute } = berlinParts(now, tz);
  return slot === "scheduled" ? `${date}T${hour}` : `${slot}:${date}T${hour}:${minute}`;
}
```

- [ ] **Step 4: Run tests** — `npx vitest run tests/alerts-state.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/monitoring/alerts/state.ts tests/alerts-state.test.ts
git commit -m "alerting: state transitions and run slots"
```

---

### Task 4: Narration (LLM writes, template falls back)

**Files:**
- Create: `lib/monitoring/alerts/narrate.ts`
- Test: `tests/alerts-narrate.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface NarrateDeps { generate?: (prompt: { system: string; user: string }) => Promise<string>; timeoutMs?: number }
  export interface Narrative { text: string; source: "llm" | "template" }
  export function narrateTransition(t: Transition, deps?: NarrateDeps): Promise<Narrative>
  export function narrateDigest(obs: Observation[], errored: string[], deps?: NarrateDeps): Promise<Narrative>
  export function templateTransition(t: Transition): string
  export function templateDigest(obs: Observation[], errored: string[]): string
  export function fmtObserved(o: Observation): string   // "15 %", "8,4 s", "1,60 $", "6×", "3,2× Basis"
  export function ruleTitle(key: RuleKey, agent: ObsAgent, subkey: string): string
  ```
- Default `generate` calls `generateText` from `ai` with `getAzureChatModel()`; any throw/timeout ⇒ template.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/alerts-narrate.test.ts
import { describe, it, expect } from "vitest";
import { narrateTransition, narrateDigest, templateTransition, fmtObserved, ruleTitle } from "../lib/monitoring/alerts/narrate";
import type { AlertRule, Observation, Transition } from "../lib/monitoring/alerts/types";

const rule = (o: Partial<AlertRule>): AlertRule => ({ id: "r1", key: "failure_rate", agent: "all", enabled: true, severity: "alert", threshold: 0.1, window_hours: 24, min_samples: 10, params: {}, description: "", ...o });
const obs = (o: Partial<Observation>): Observation => ({ rule: rule({}), agent: "faq", subkey: "", status: "breached", observed: 0.15, samples: 20, threshold: 0.1, ...o });
const fired: Transition = { kind: "fired", obs: obs({}) };

describe("formatting", () => {
  it("formats by rule key", () => {
    expect(fmtObserved(obs({}))).toBe("15 %");
    expect(fmtObserved(obs({ rule: rule({ key: "latency_p95" }), observed: 8400 }))).toBe("8,4 s");
    expect(fmtObserved(obs({ rule: rule({ key: "cost_daily" }), observed: 1.6 }))).toBe("1,60 $");
    expect(fmtObserved(obs({ rule: rule({ key: "cost_spike" }), observed: 3.2 }))).toBe("3,2× Basis");
    expect(fmtObserved(obs({ rule: rule({ key: "error_repeat" }), observed: 6 }))).toBe("6×");
  });
  it("titles name the agent and the error type", () => {
    expect(ruleTitle("failure_rate", "faq", "")).toBe("Fehlerrate · FAQ");
    expect(ruleTitle("error_repeat", "total", "azure_429")).toBe("Wiederholter Fehler azure_429 · Gesamt");
  });
});

describe("narrateTransition", () => {
  it("uses the model text when it returns", async () => {
    const n = await narrateTransition(fired, { generate: async () => "Die Fehlerrate des FAQ-Agenten liegt bei 15 %." });
    expect(n).toEqual({ text: "Die Fehlerrate des FAQ-Agenten liegt bei 15 %.", source: "llm" });
  });
  it("falls back to the template on throw, and on timeout", async () => {
    const a = await narrateTransition(fired, { generate: async () => { throw new Error("boom"); } });
    expect(a.source).toBe("template");
    expect(a.text).toBe(templateTransition(fired));
    const b = await narrateTransition(fired, { generate: () => new Promise(() => {}), timeoutMs: 20 });
    expect(b.source).toBe("template");
  });
  it("template states metric, value, threshold, window and a first check", () => {
    const t = templateTransition(fired);
    expect(t).toContain("Fehlerrate · FAQ");
    expect(t).toContain("15 %");
    expect(t).toContain("10 %");
    expect(t).toContain("24 h");
    expect(t).toMatch(/prüfen/i);
  });
  it("recovery template says recovered", () => {
    expect(templateTransition({ kind: "recovered", obs: obs({ status: "ok", observed: 0.02 }) })).toMatch(/wieder im grünen Bereich/);
  });
  it("sends the numbers to the model, not free text", async () => {
    let user = "";
    await narrateTransition(fired, { generate: async (p) => { user = p.user; return "x"; } });
    const parsed = JSON.parse(user);
    expect(parsed.observed).toBe("15 %");
    expect(parsed.threshold).toBe("10 %");
  });
});

describe("narrateDigest", () => {
  it("template lists every observation and errored rules", async () => {
    const n = await narrateDigest([obs({}), obs({ status: "ok", agent: "partner", observed: 0.01 })], ["cost_spike"], { generate: async () => { throw new Error("x"); } });
    expect(n.source).toBe("template");
    expect(n.text).toContain("Fehlerrate · FAQ");
    expect(n.text).toContain("Fehlerrate · Partner");
    expect(n.text).toContain("cost_spike");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/alerts-narrate.test.ts` — Expected: FAIL.

- [ ] **Step 3: Write narrate.ts**

```ts
// lib/monitoring/alerts/narrate.ts — the LLM phrases; rules decided (spec §6).
// Every number the model may use is pre-formatted here and passed as JSON; the
// fixed system prompt forbids inventing others. Any failure ⇒ template.
import type { LanguageModel } from "ai";
import type { Observation, ObsAgent, RuleKey, Transition } from "./types";

export interface NarrateDeps {
  generate?: (prompt: { system: string; user: string }) => Promise<string>;
  timeoutMs?: number;
}
export interface Narrative { text: string; source: "llm" | "template" }

const AGENT_LABEL: Record<ObsAgent, string> = { faq: "FAQ", partner: "Partner", total: "Gesamt" };
const RULE_LABEL: Record<RuleKey, string> = {
  cost_daily: "Tageskosten", cost_spike: "Kostenanstieg", failure_rate: "Fehlerrate", latency_p95: "Antwortzeit p95",
  negative_feedback: "Negatives Feedback", error_repeat: "Wiederholter Fehler", partner_upstream: "Partner-Agent nicht erreichbar",
};
const FIRST_CHECK: Record<RuleKey, string> = {
  cost_daily: "Die teuersten Traces des Tages unter /monitoring nach Kosten prüfen.",
  cost_spike: "Prüfen, ob Traffic oder Antwortlänge gestiegen ist (Traces der letzten 24 h).",
  failure_rate: "Die neuesten Fehler unter /monitoring prüfen (Azure 429, Timeouts).",
  latency_p95: "Langsame Traces öffnen und den langsamsten Schritt prüfen (Modell oder Partner-Suche).",
  negative_feedback: "Die 👎-Antworten in der Review-Queue lesen.",
  error_repeat: "Die Fehlermeldung in den neuesten Traces öffnen.",
  partner_upstream: "Deployment und PARTNER_AGENT_HOST des Partner-Agents prüfen.",
};

const de = (n: number, digits: number) => n.toLocaleString("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits });

export function fmtValue(key: RuleKey, v: number | null): string {
  if (v === null) return "—";
  switch (key) {
    case "failure_rate": case "negative_feedback": return `${Math.round(v * 100)} %`;
    case "latency_p95": return `${de(v / 1000, 1)} s`;
    case "cost_daily": return `${de(v, 2)} $`;
    case "cost_spike": return `${de(v, 1)}× Basis`;
    case "error_repeat": case "partner_upstream": return `${v}×`;
  }
}
export const fmtObserved = (o: Observation) => fmtValue(o.rule.key, o.observed);
export const fmtThreshold = (o: Observation) => fmtValue(o.rule.key, o.threshold);

export function ruleTitle(key: RuleKey, agent: ObsAgent, subkey: string): string {
  const base = key === "error_repeat" && subkey ? `${RULE_LABEL[key]} ${subkey}` : RULE_LABEL[key];
  return `${base} · ${AGENT_LABEL[agent]}`;
}

export function templateTransition(t: Transition): string {
  const o = t.obs;
  const title = ruleTitle(o.rule.key, o.agent, o.subkey);
  const win = o.rule.key === "cost_daily" ? "heute" : `${o.rule.window_hours} h`;
  if (t.kind === "recovered") return `${title} ist wieder im grünen Bereich: ${fmtObserved(o)} (Grenze ${fmtThreshold(o)}, Fenster ${win}).`;
  const samples = o.samples ? ` bei ${o.samples} Turns` : "";
  return `${title}: ${fmtObserved(o)}${samples} in den letzten ${win}, Grenze ${fmtThreshold(o)}. ${FIRST_CHECK[o.rule.key]}`;
}

export function templateDigest(obs: Observation[], errored: string[]): string {
  const breached = obs.filter((o) => o.status === "breached");
  const head = breached.length === 0 ? "Alles im grünen Bereich." : `${breached.length} Regel(n) verletzt.`;
  const lines = obs.map((o) => `${o.status === "breached" ? "🔴" : o.status === "skipped" ? "⚪" : "🟢"} ${ruleTitle(o.rule.key, o.agent, o.subkey)}: ${fmtObserved(o)} (Grenze ${fmtThreshold(o)})${o.note ? ` – ${o.note}` : ""}`);
  const err = errored.length ? `\n⚠️ Nicht auswertbar: ${errored.join(", ")}` : "";
  return `${head}\n${lines.join("\n")}${err}`;
}

const SYSTEM = [
  "Du schreibst kurze Statusmeldungen für das Team, das den Navio-Chatbot betreibt.",
  "Sprache: Deutsch, einfache Sätze, kein Markdown, keine Überschriften, keine Entschuldigungen.",
  "Benutze ausschließlich die Zahlen und Bezeichnungen aus dem JSON. Erfinde keine weiteren Zahlen.",
  "Bei einem Alarm: nenne Agent, Metrik, beobachteten Wert, Grenze und Zeitfenster; schließe mit genau einem konkreten ersten Prüfschritt (aus first_check).",
  "Bei einer Entwarnung: ein Satz, dass der Wert wieder unter der Grenze liegt.",
  "Beim Digest: zwei bis vier Sätze Gesamtlage, verletzte Regeln zuerst; wenn alles ok ist, sag das knapp.",
  "Maximal 120 Wörter.",
].join(" ");

async function defaultGenerate(p: { system: string; user: string }): Promise<string> {
  const { generateText } = await import("ai");
  const { getAzureChatModel } = await import("../../llm");
  const model: LanguageModel = getAzureChatModel();
  const r = await generateText({ model, system: p.system, prompt: p.user, maxOutputTokens: 400, temperature: 0.2 });
  return r.text.trim();
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<T>((_, rej) => { timer = setTimeout(() => rej(new Error("narrate timeout")), ms); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function run(user: Record<string, unknown>, fallback: string, deps: NarrateDeps): Promise<Narrative> {
  const generate = deps.generate ?? defaultGenerate;
  try {
    const text = await withTimeout(generate({ system: SYSTEM, user: JSON.stringify(user) }), deps.timeoutMs ?? 8000);
    if (!text || text.length > 1200) return { text: fallback, source: "template" };
    return { text, source: "llm" };
  } catch {
    return { text: fallback, source: "template" };
  }
}

export function narrateTransition(t: Transition, deps: NarrateDeps = {}): Promise<Narrative> {
  const o = t.obs;
  return run({
    kind: t.kind === "fired" ? "alarm" : "entwarnung",
    severity: o.rule.severity,
    metric: ruleTitle(o.rule.key, o.agent, o.subkey),
    observed: fmtObserved(o), threshold: fmtThreshold(o),
    samples: o.samples, window: o.rule.key === "cost_daily" ? "heute (Berlin)" : `${o.rule.window_hours} h`,
    note: o.note ?? null, first_check: FIRST_CHECK[o.rule.key],
  }, templateTransition(t), deps);
}

export function narrateDigest(obs: Observation[], errored: string[], deps: NarrateDeps = {}): Promise<Narrative> {
  return run({
    kind: "digest",
    rules: obs.map((o) => ({ metric: ruleTitle(o.rule.key, o.agent, o.subkey), status: o.status, observed: fmtObserved(o), threshold: fmtThreshold(o), note: o.note ?? null })),
    not_evaluable: errored,
  }, templateDigest(obs, errored), deps);
}
```

- [ ] **Step 4: Run tests** — `npx vitest run tests/alerts-narrate.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/monitoring/alerts/narrate.ts tests/alerts-narrate.test.ts
git commit -m "alerting: LLM narration with template fallback"
```

---

### Task 5: Delivery — Teams card facts, monitoring alert messages

**Files:**
- Modify: `lib/monitoring/format-alert.ts` (add optional `facts` to `AlertMessage`, render as FactSet; add `toMonitoringAlertMessage`)
- Create: `lib/monitoring/alerts/deliver.ts`
- Test: `tests/alerts-deliver.test.ts`
- Modify: `tests/monitoring-format.test.ts` (one added case for facts)

**Interfaces:**
- `AlertMessage` gains `facts?: { title: string; value: string }[]` and `linkLabel?: string` (default "Open in Langfuse"; monitoring uses "Dashboard öffnen").
- Produces (deliver.ts):
  ```ts
  export interface DeliverDeps { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; recipients?: string[]; dashboardUrl?: string }
  export type Delivery = { teams: string; email: string }   // "sent" | "skipped" | "failed: <detail>"
  export function transitionMessage(t: Transition, narrative: string, dashboardUrl: string): AlertMessage
  export function digestMessage(obs: Observation[], errored: string[], narrative: string, dashboardUrl: string): AlertMessage
  export function testMessage(dashboardUrl: string): AlertMessage
  export function deliver(msg: AlertMessage, channels: { teams: boolean; email: boolean }, deps?: DeliverDeps): Promise<Delivery>
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/alerts-deliver.test.ts
import { describe, it, expect, vi } from "vitest";
import { deliver, transitionMessage, digestMessage, testMessage } from "../lib/monitoring/alerts/deliver";
import { formatTeamsCard } from "../lib/monitoring/format-alert";
import type { AlertRule, Observation, Transition } from "../lib/monitoring/alerts/types";

const rule: AlertRule = { id: "r1", key: "failure_rate", agent: "all", enabled: true, severity: "alert", threshold: 0.1, window_hours: 24, min_samples: 10, params: {}, description: "" };
const obs: Observation = { rule, agent: "faq", subkey: "", status: "breached", observed: 0.15, samples: 20, threshold: 0.1 };
const fired: Transition = { kind: "fired", obs };
const URL = "https://navio-widget.vercel.app/monitoring/alerts";

describe("messages", () => {
  it("fired → ALERT severity, monitoring label, dashboard link, fact rows", () => {
    const m = transitionMessage(fired, "Text.", URL);
    expect(m.severity).toBe("ALERT");
    expect(m.projectLabel).toBe("Navio Monitoring");
    expect(m.permalink).toBe(URL);
    expect(m.linkLabel).toBe("Dashboard öffnen");
    expect(m.facts?.map((f) => f.title)).toEqual(["Wert", "Grenze", "Fenster", "Turns"]);
    expect(m.title).toBe("Fehlerrate · FAQ");
  });
  it("warning rule → WARNING; recovered → OK", () => {
    expect(transitionMessage({ kind: "fired", obs: { ...obs, rule: { ...rule, severity: "warning" } } }, "x", URL).severity).toBe("WARNING");
    expect(transitionMessage({ kind: "recovered", obs: { ...obs, status: "ok" } }, "x", URL).severity).toBe("OK");
  });
  it("digest has one fact per observation and renders a FactSet", () => {
    const m = digestMessage([obs, { ...obs, agent: "partner", status: "ok", observed: 0.01 }], [], "Lage.", URL);
    expect(m.facts).toHaveLength(2);
    const card = formatTeamsCard(m) as { attachments: { content: { body: { type: string }[] } }[] };
    expect(card.attachments[0].content.body.some((b) => b.type === "FactSet")).toBe(true);
  });
  it("test message is labelled", () => {
    expect(testMessage(URL).title).toMatch(/Testalarm/);
  });
});

describe("deliver", () => {
  const env = { TEAMS_ALERT_WEBHOOK_URL: "https://teams.example/hook" } as unknown as NodeJS.ProcessEnv;
  it("sends to teams, skips email when not configured", async () => {
    const fetchImpl = vi.fn(async () => new Response("1", { status: 200 })) as unknown as typeof fetch;
    const d = await deliver(transitionMessage(fired, "t", URL), { teams: true, email: true }, { fetchImpl, env });
    expect(d.teams).toBe("sent");
    expect(d.email).toBe("skipped");
  });
  it("records a teams failure without throwing", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 400 })) as unknown as typeof fetch;
    const d = await deliver(transitionMessage(fired, "t", URL), { teams: true, email: false }, { fetchImpl, env });
    expect(d.teams).toMatch(/^failed: HTTP 400/);
    expect(d.email).toBe("skipped");
  });
  it("channel false ⇒ skipped without a call", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const d = await deliver(transitionMessage(fired, "t", URL), { teams: false, email: false }, { fetchImpl, env });
    expect(d).toEqual({ teams: "skipped", email: "skipped" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
```

Add to `tests/monitoring-format.test.ts`:

```ts
it("renders facts as a FactSet and a custom link label", () => {
  const card = formatTeamsCard({ ...msg, facts: [{ title: "Wert", value: "15 %" }], linkLabel: "Dashboard öffnen" }) as { attachments: { content: { body: Record<string, unknown>[] } }[] };
  const body = card.attachments[0].content.body;
  expect(body.find((b) => b.type === "FactSet")).toMatchObject({ facts: [{ title: "Wert", value: "15 %" }] });
  expect(JSON.stringify(body)).toContain("[Dashboard öffnen](");
});
```

(`msg` is the existing fixture in that file.)

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/alerts-deliver.test.ts tests/monitoring-format.test.ts` — Expected: FAIL.

- [ ] **Step 3: Extend format-alert.ts**

In `AlertMessage` add:
```ts
  /** Optional key/value rows (Adaptive Card FactSet; a small table in email). */
  facts?: { title: string; value: string }[];
  /** Label for the permalink (default "Open in Langfuse"). */
  linkLabel?: string;
```
In `formatTeamsCard`, after the detail TextBlock and before the permalink block insert:
```ts
  if (msg.facts && msg.facts.length > 0) {
    body.push({ type: "FactSet", facts: msg.facts.map((f) => ({ title: f.title, value: f.value })) });
  }
```
and change the permalink line to:
```ts
    body.push({ type: "TextBlock", text: `[${msg.linkLabel ?? "Open in Langfuse"}](${msg.permalink})`, wrap: true });
```
In `formatEmailHtml`, change `link` to use `escapeHtml(msg.linkLabel ?? "Open in Langfuse")` and add after the detail paragraph:
```ts
    msg.facts && msg.facts.length > 0
      ? `<table style="border-collapse:collapse;font-size:13px">${msg.facts.map((f) => `<tr><td style="padding:2px 12px 2px 0;color:#666">${escapeHtml(f.title)}</td><td style="padding:2px 0">${escapeHtml(f.value)}</td></tr>`).join("")}</table>`
      : "",
```
In `formatEmailText`, after `msg.detail` push `...(msg.facts ?? []).map((f) => `${f.title}: ${f.value}`)` and use `msg.linkLabel ?? "Open in Langfuse"` for the link line.

- [ ] **Step 4: Write deliver.ts**

```ts
// lib/monitoring/alerts/deliver.ts — builds AlertMessages for the monitoring rules and
// sends them through the EXISTING channels (teams.ts, graph-mail.ts). Never throws.
import type { AlertMessage } from "../format-alert";
import { sendTeamsAlert, teamsEnabled } from "../teams";
import { sendAlertEmail, graphMailEnabled } from "../graph-mail";
import { fmtObserved, fmtThreshold, ruleTitle } from "./narrate";
import type { Observation, Transition } from "./types";

export const PROJECT_LABEL = "Navio Monitoring";
const LINK_LABEL = "Dashboard öffnen";

export interface DeliverDeps { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; recipients?: string[] }
export type Delivery = { teams: string; email: string };

const SEV: Record<AlertMessage["severity"], string> = { ALERT: "🔴", WARNING: "🟡", OK: "🟢", NO_DATA: "⚪", PAUSED: "⏸️", UNKNOWN: "⚫" };
function base(severity: AlertMessage["severity"], title: string, detail: string, url: string): AlertMessage {
  return { title, detail, severity, severityEmoji: SEV[severity], severityLabel: severity, projectLabel: PROJECT_LABEL, window: "", permalink: url, linkLabel: LINK_LABEL, timestampIso: new Date().toISOString() };
}
const windowOf = (o: Observation) => (o.rule.key === "cost_daily" ? "heute (Berlin)" : `${o.rule.window_hours} h`);

export function transitionMessage(t: Transition, narrative: string, dashboardUrl: string): AlertMessage {
  const o = t.obs;
  const severity: AlertMessage["severity"] = t.kind === "recovered" ? "OK" : o.rule.severity === "alert" ? "ALERT" : "WARNING";
  const m = base(severity, ruleTitle(o.rule.key, o.agent, o.subkey), narrative, dashboardUrl);
  m.window = windowOf(o);
  m.facts = [
    { title: "Wert", value: fmtObserved(o) },
    { title: "Grenze", value: fmtThreshold(o) },
    { title: "Fenster", value: windowOf(o) },
    { title: "Turns", value: String(o.samples) },
  ];
  return m;
}

export function digestMessage(obs: Observation[], errored: string[], narrative: string, dashboardUrl: string): AlertMessage {
  const breached = obs.filter((o) => o.status === "breached").length;
  const m = base(breached > 0 ? "ALERT" : "OK", breached > 0 ? `Status: ${breached} Regel(n) verletzt` : "Status: alles im grünen Bereich", narrative, dashboardUrl);
  m.window = "Digest";
  m.facts = obs.map((o) => ({
    title: `${o.status === "breached" ? "🔴" : o.status === "skipped" ? "⚪" : "🟢"} ${ruleTitle(o.rule.key, o.agent, o.subkey)}`,
    value: `${fmtObserved(o)} / ${fmtThreshold(o)}${o.note ? ` – ${o.note}` : ""}`,
  }));
  if (errored.length) m.facts.push({ title: "⚠️ Nicht auswertbar", value: errored.join(", ") });
  return m;
}

export function testMessage(dashboardUrl: string): AlertMessage {
  return base("WARNING", "Testalarm", "Dies ist ein Testalarm aus dem Navio-Monitoring. Keine Aktion nötig.", dashboardUrl);
}

export async function deliver(msg: AlertMessage, channels: { teams: boolean; email: boolean }, deps: DeliverDeps = {}): Promise<Delivery> {
  const env = deps.env ?? process.env;
  const emailEnv: NodeJS.ProcessEnv = deps.recipients && deps.recipients.length > 0 ? { ...env, ALERT_EMAIL_TO: deps.recipients.join(",") } : env;
  const [t, e] = await Promise.allSettled([
    channels.teams && teamsEnabled(env) ? sendTeamsAlert(msg, { fetchImpl: deps.fetchImpl, env }) : Promise.resolve({ ok: false, detail: "not configured" }),
    channels.email && graphMailEnabled() ? sendAlertEmail(msg, { fetchImpl: deps.fetchImpl, env: emailEnv }) : Promise.resolve({ ok: false, detail: "not configured" }),
  ]);
  return { teams: status(t), email: status(e) };
}

function status(r: PromiseSettledResult<{ ok: boolean; detail: string }>): string {
  if (r.status === "rejected") return `failed: ${(r.reason as Error)?.message ?? String(r.reason)}`;
  if (r.value.ok) return "sent";
  if (r.value.detail === "not configured" || r.value.detail.startsWith("no recipients")) return "skipped";
  return `failed: ${r.value.detail}`;
}
```

- [ ] **Step 5: Run** — `npx vitest run tests/alerts-deliver.test.ts tests/monitoring-format.test.ts tests/monitoring-teams.test.ts tests/monitoring-relay.test.ts` — Expected: PASS (existing relay/teams tests unchanged).

- [ ] **Step 6: Commit**

```bash
git add lib/monitoring/format-alert.ts lib/monitoring/alerts/deliver.ts tests/alerts-deliver.test.ts tests/monitoring-format.test.ts
git commit -m "alerting: monitoring alert messages, FactSet cards, delivery wrapper"
```

---

### Task 6: Evaluation orchestrator + `/api/monitoring/alerts/evaluate`

**Files:**
- Create: `lib/monitoring/alerts/repo.ts` (all Supabase reads/writes for alerting, behind an interface)
- Create: `lib/monitoring/alerts/evaluate.ts`
- Create: `app/api/monitoring/alerts/evaluate/route.ts`
- Test: `tests/alerts-evaluate.test.ts`
- Modify: `.env.example` (add `ALERT_EVALUATE_SECRET`)

**Interfaces:**
- repo.ts:
  ```ts
  export interface AlertRepo {
    rules(): Promise<AlertRule[]>;                        // enabled + disabled (evaluate filters)
    states(): Promise<AlertStateRow[]>;
    settings(): Promise<{ email_recipients: string[]; digest_enabled: boolean }>;
    window(env: string, hours: number): Promise<WindowMetrics>;
    costDay(env: string, tz: string, baselineDays: number): Promise<CostDay>;
    saveStates(rows: AlertStateRow[]): Promise<void>;     // upsert on (rule_id, agent, subkey)
    insertEvent(e: NewEvent): Promise<{ inserted: boolean; id?: string }>;  // digest: on conflict run_slot do nothing
    updateEventDelivery(id: string, delivery: Delivery): Promise<void>;
  }
  export interface NewEvent { kind: EventKind; rule_key?: string; agent?: string; subkey?: string; severity?: string; observed?: number|null; threshold?: number; samples?: number; window_hours?: number; window_from?: string; window_to?: string; narrative: string; narrative_source: "llm"|"template"; run_slot: string }
  export function supabaseAlertRepo(): AlertRepo | undefined   // undefined when MONITORING_SUPABASE_* unset
  ```
- evaluate.ts:
  ```ts
  export interface EvaluateOptions { slot: "scheduled"|"test"|"manual"; dryRun?: boolean; now?: Date; env?: string; dashboardUrl?: string }
  export interface EvaluateDeps { repo?: AlertRepo; narrate?: NarrateDeps; deliver?: DeliverDeps }
  export interface EvaluateResult { ok: boolean; slot: string; transitions: { kind: string; rule_key: string; agent: string; subkey: string; observed: number|null; threshold: number; narrative: string; delivery?: Delivery }[]; digest: { sent: boolean; narrative: string; delivery?: Delivery }; observations: Array<{ rule_key: string; agent: string; subkey: string; status: string; observed: number|null; threshold: number; samples: number; note?: string }>; errored: string[] }
  export function runEvaluation(opts: EvaluateOptions, deps?: EvaluateDeps): Promise<EvaluateResult | undefined>
  ```
- Route: `POST /api/monitoring/alerts/evaluate`, header `Authorization: Bearer ${ALERT_EVALUATE_SECRET}`; 404 when secret unset, 401 when wrong, body `{slot?, dryRun?}`.

- [ ] **Step 1: Write the failing tests (in-memory repo)**

```ts
// tests/alerts-evaluate.test.ts
import { describe, it, expect, vi } from "vitest";
import { runEvaluation } from "../lib/monitoring/alerts/evaluate";
import type { AlertRepo, NewEvent } from "../lib/monitoring/alerts/repo";
import type { AlertRule, AlertStateRow, WindowAgg } from "../lib/monitoring/alerts/types";

const agg = (o: Partial<WindowAgg> = {}): WindowAgg => ({ traces: 0, failed: 0, abandoned: 0, cost_usd: 0, p95_ms: null, rated: 0, down: 0, error_types: [], ...o });
const failureRule: AlertRule = { id: "r1", key: "failure_rate", agent: "faq", enabled: true, severity: "alert", threshold: 0.1, window_hours: 24, min_samples: 10, params: {}, description: "" };

function memRepo(opts: { rules?: AlertRule[]; states?: AlertStateRow[]; faq?: Partial<WindowAgg>; digest?: boolean; recipients?: string[]; windowThrows?: boolean }) {
  const events: (NewEvent & { id: string; delivery?: unknown })[] = [];
  let states = opts.states ?? [];
  const repo: AlertRepo = {
    rules: async () => opts.rules ?? [failureRule],
    states: async () => states,
    settings: async () => ({ email_recipients: opts.recipients ?? [], digest_enabled: opts.digest ?? true }),
    window: async () => { if (opts.windowThrows) throw new Error("db down"); return { faq: agg(opts.faq), partner: agg(), total: agg(opts.faq) }; },
    costDay: async () => ({ today: { faq: 0, partner: 0, total: 0 }, baseline_days: 0, baseline_avg: { faq: 0, partner: 0, total: 0 } }),
    saveStates: async (rows) => { states = rows; },
    insertEvent: async (e) => { if (e.kind === "digest" && events.some((x) => x.kind === "digest" && x.run_slot === e.run_slot)) return { inserted: false }; const id = `e${events.length + 1}`; events.push({ ...e, id }); return { inserted: true, id }; },
    updateEventDelivery: async (id, delivery) => { const e = events.find((x) => x.id === id); if (e) e.delivery = delivery; },
  };
  return { repo, events, get states() { return states; } };
}
const deps = (repo: AlertRepo, fetchImpl = vi.fn(async () => new Response("1", { status: 200 })) as unknown as typeof fetch) => ({
  repo,
  narrate: { generate: async () => "LLM-Text." },
  deliver: { fetchImpl, env: { TEAMS_ALERT_WEBHOOK_URL: "https://teams.example/hook" } as unknown as NodeJS.ProcessEnv },
});
const NOW = new Date("2026-09-15T05:00:00Z");

describe("runEvaluation", () => {
  it("fires on a fresh breach, writes state + event, delivers, and sends a digest for a scheduled slot", async () => {
    const m = memRepo({ faq: { traces: 20, failed: 4 } });
    const r = await runEvaluation({ slot: "scheduled", now: NOW }, deps(m.repo));
    expect(r?.transitions).toHaveLength(1);
    expect(r?.transitions[0]).toMatchObject({ kind: "fired", rule_key: "failure_rate", agent: "faq", delivery: { teams: "sent", email: "skipped" } });
    expect(m.states[0].status).toBe("breached");
    expect(m.events.map((e) => e.kind)).toEqual(["fired", "digest"]);
    expect(m.events[0].narrative).toBe("LLM-Text.");
    expect(r?.digest.sent).toBe(true);
  });
  it("second run in the same slot: no transition, no second digest", async () => {
    const m = memRepo({ faq: { traces: 20, failed: 4 } });
    await runEvaluation({ slot: "scheduled", now: NOW }, deps(m.repo));
    const r = await runEvaluation({ slot: "scheduled", now: NOW }, deps(m.repo));
    expect(r?.transitions).toHaveLength(0);
    expect(r?.digest.sent).toBe(false);
    expect(m.events.filter((e) => e.kind === "digest")).toHaveLength(1);
  });
  it("recovers when the rate drops", async () => {
    const m = memRepo({ faq: { traces: 20, failed: 4 } });
    await runEvaluation({ slot: "manual", now: NOW }, deps(m.repo));
    const m2 = memRepo({ faq: { traces: 20, failed: 0 }, states: m.states });
    const r = await runEvaluation({ slot: "manual", now: NOW }, deps(m2.repo));
    expect(r?.transitions[0].kind).toBe("recovered");
  });
  it("test slot writes a digest event but does not send it", async () => {
    const m = memRepo({});
    const fetchImpl = vi.fn(async () => new Response("1", { status: 200 })) as unknown as typeof fetch;
    const r = await runEvaluation({ slot: "test", now: NOW }, deps(m.repo, fetchImpl));
    expect(m.events.some((e) => e.kind === "digest")).toBe(true);
    expect(r?.digest.sent).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("digest disabled ⇒ not sent", async () => {
    const m = memRepo({ digest: false });
    const r = await runEvaluation({ slot: "scheduled", now: NOW }, deps(m.repo));
    expect(r?.digest.sent).toBe(false);
  });
  it("dryRun computes but writes and sends nothing", async () => {
    const m = memRepo({ faq: { traces: 20, failed: 4 } });
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const r = await runEvaluation({ slot: "manual", now: NOW, dryRun: true }, deps(m.repo, fetchImpl));
    expect(r?.transitions).toHaveLength(1);
    expect(m.events).toHaveLength(0);
    expect(m.states).toHaveLength(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("a failing metrics query marks the rule errored instead of ok", async () => {
    const m = memRepo({ windowThrows: true, states: [{ rule_id: "r1", agent: "faq", subkey: "", status: "breached", observed: 0.2, samples: 20, last_evaluated_at: NOW.toISOString(), last_transition_at: null }] });
    const r = await runEvaluation({ slot: "manual", now: NOW }, deps(m.repo));
    expect(r?.errored).toEqual(["failure_rate"]);
    expect(r?.transitions).toHaveLength(0);
    expect(m.states[0].status).toBe("breached"); // untouched
  });
  it("delivery failure does not block the state transition", async () => {
    const m = memRepo({ faq: { traces: 20, failed: 4 } });
    const fetchImpl = vi.fn(async () => new Response("x", { status: 500 })) as unknown as typeof fetch;
    const r = await runEvaluation({ slot: "manual", now: NOW }, deps(m.repo, fetchImpl));
    expect(r?.transitions[0].delivery?.teams).toMatch(/^failed/);
    expect(m.states[0].status).toBe("breached");
  });
  it("no repo ⇒ undefined (silent no-op)", async () => {
    expect(await runEvaluation({ slot: "manual" }, { repo: undefined })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/alerts-evaluate.test.ts` — Expected: FAIL.

- [ ] **Step 3: Write repo.ts**

```ts
// lib/monitoring/alerts/repo.ts — every Supabase touch for alerting, behind one interface
// so evaluate.ts is testable with an in-memory implementation.
import { supabaseAdmin } from "../store";
import type { AlertRule, AlertStateRow, CostDay, EventKind, WindowMetrics } from "./types";
import type { Delivery } from "./deliver";

export interface NewEvent {
  kind: EventKind; rule_key?: string; agent?: string; subkey?: string; severity?: string;
  observed?: number | null; threshold?: number; samples?: number; window_hours?: number;
  window_from?: string; window_to?: string; narrative: string; narrative_source: "llm" | "template"; run_slot: string;
}
export interface AlertSettings { email_recipients: string[]; digest_enabled: boolean }

export interface AlertRepo {
  rules(): Promise<AlertRule[]>;
  states(): Promise<AlertStateRow[]>;
  settings(): Promise<AlertSettings>;
  window(env: string, hours: number): Promise<WindowMetrics>;
  costDay(env: string, tz: string, baselineDays: number): Promise<CostDay>;
  saveStates(rows: AlertStateRow[]): Promise<void>;
  insertEvent(e: NewEvent): Promise<{ inserted: boolean; id?: string }>;
  updateEventDelivery(id: string, delivery: Delivery): Promise<void>;
}

const n = (v: unknown): number => (typeof v === "string" ? Number(v) : typeof v === "number" ? v : 0);
const nn = (v: unknown): number | null => (v === null || v === undefined ? null : n(v));

function toRule(r: Record<string, unknown>): AlertRule {
  return {
    id: String(r.id), key: r.key as AlertRule["key"], agent: r.agent as AlertRule["agent"], enabled: Boolean(r.enabled),
    severity: r.severity as AlertRule["severity"], threshold: n(r.threshold), window_hours: n(r.window_hours),
    min_samples: n(r.min_samples), params: (r.params as Record<string, unknown>) ?? {}, description: String(r.description ?? ""),
  };
}
function toAgg(w: Record<string, unknown>) {
  return { traces: n(w.traces), failed: n(w.failed), abandoned: n(w.abandoned), cost_usd: n(w.cost_usd), p95_ms: nn(w.p95_ms), rated: n(w.rated), down: n(w.down), error_types: ((w.error_types as { type: string; n: unknown }[]) ?? []).map((e) => ({ type: e.type, n: n(e.n) })) };
}

export function supabaseAlertRepo(): AlertRepo | undefined {
  const db = supabaseAdmin();
  if (!db) return undefined;
  const must = async <T,>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> => {
    const { data, error } = await p;
    if (error) throw new Error(error.message);
    return data as T;
  };
  return {
    rules: async () => (await must<Record<string, unknown>[]>(db.from("alert_rules").select("*").order("key"))).map(toRule),
    states: async () => (await must<Record<string, unknown>[]>(db.from("alert_state").select("*"))).map((s) => ({
      rule_id: String(s.rule_id), agent: String(s.agent), subkey: String(s.subkey ?? ""), status: s.status as AlertStateRow["status"],
      observed: nn(s.observed), samples: nn(s.samples), last_evaluated_at: String(s.last_evaluated_at), last_transition_at: (s.last_transition_at as string | null) ?? null,
    })),
    settings: async () => {
      const s = await must<Record<string, unknown> | null>(db.from("alert_settings").select("*").eq("id", 1).maybeSingle());
      return { email_recipients: ((s?.email_recipients as string[]) ?? []).filter(Boolean), digest_enabled: s ? Boolean(s.digest_enabled) : true };
    },
    window: async (env, hours) => {
      const d = await must<Record<string, Record<string, unknown>>>(db.rpc("monitoring_alert_window", { p_env: env, p_hours: hours }));
      return { faq: toAgg(d.faq), partner: toAgg(d.partner), total: toAgg(d.total) };
    },
    costDay: async (env, tz, baselineDays) => {
      const d = await must<Record<string, unknown>>(db.rpc("monitoring_alert_cost_day", { p_env: env, p_tz: tz, p_baseline_days: baselineDays }));
      const t = d.today as Record<string, unknown>; const b = d.baseline_avg as Record<string, unknown>;
      return { today: { faq: n(t.faq), partner: n(t.partner), total: n(t.total) }, baseline_days: n(d.baseline_days), baseline_avg: { faq: n(b.faq), partner: n(b.partner), total: n(b.total) } };
    },
    saveStates: async (rows) => { if (rows.length) await must(db.from("alert_state").upsert(rows, { onConflict: "rule_id,agent,subkey" })); },
    insertEvent: async (e) => {
      const q = db.from("alert_events").insert(e).select("id").maybeSingle();
      const { data, error } = await q;
      if (error) { if (e.kind === "digest" && /duplicate key|alert_events_digest_slot_idx/i.test(error.message)) return { inserted: false }; throw new Error(error.message); }
      return { inserted: true, id: data ? String((data as { id: string }).id) : undefined };
    },
    updateEventDelivery: async (id, delivery) => { await must(db.from("alert_events").update({ delivery }).eq("id", id)); },
  };
}
```

- [ ] **Step 4: Write evaluate.ts**

```ts
// lib/monitoring/alerts/evaluate.ts — one run: metrics → rules → diff → events → deliver (spec §5).
import { evaluateAll } from "./rules";
import { diffStates, runSlot } from "./state";
import { narrateDigest, narrateTransition, type NarrateDeps } from "./narrate";
import { deliver, digestMessage, transitionMessage, type DeliverDeps, type Delivery } from "./deliver";
import { supabaseAlertRepo, type AlertRepo } from "./repo";
import type { AlertRule, MetricsInput, Observation, Transition, WindowMetrics } from "./types";

export interface EvaluateOptions { slot: "scheduled" | "test" | "manual"; dryRun?: boolean; now?: Date; env?: string; dashboardUrl?: string; tz?: string }
export interface EvaluateDeps { repo?: AlertRepo; narrate?: NarrateDeps; deliver?: DeliverDeps }
export interface EvaluateResult {
  ok: boolean; slot: string; dryRun: boolean;
  transitions: { kind: "fired" | "recovered"; rule_key: string; agent: string; subkey: string; observed: number | null; threshold: number; narrative: string; delivery?: Delivery }[];
  digest: { sent: boolean; narrative: string; delivery?: Delivery };
  observations: { rule_key: string; agent: string; subkey: string; status: string; observed: number | null; threshold: number; samples: number; note?: string }[];
  errored: string[];
}

export function dashboardUrl(env: NodeJS.ProcessEnv = process.env): string {
  const host = env.ALERT_DASHBOARD_URL?.trim() || (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://127.0.0.1:3001");
  return `${host.replace(/\/$/, "")}/monitoring/alerts`;
}

export async function runEvaluation(opts: EvaluateOptions, deps: EvaluateDeps = {}): Promise<EvaluateResult | undefined> {
  const repo = "repo" in deps ? deps.repo : supabaseAlertRepo();
  if (!repo) return undefined;
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const env = opts.env ?? "production";
  const tz = opts.tz ?? "Europe/Berlin";
  const slot = runSlot(opts.slot, now, tz);
  const url = opts.dashboardUrl ?? dashboardUrl();

  const [allRules, prevStates, settings] = await Promise.all([repo.rules(), repo.states(), repo.settings()]);
  const rules = allRules.filter((r) => r.enabled);

  // Metrics: one window call per distinct window_hours, one cost-day call; per-call failures mark rules errored.
  const errored: string[] = [];
  const hoursList = [...new Set(rules.map((r) => r.window_hours))];
  const windows: Record<number, WindowMetrics> = {};
  await Promise.all(hoursList.map(async (h) => { try { windows[h] = await repo.window(env, h); } catch { /* rules on this window become errored below */ } }));
  const needsCost = rules.some((r) => r.key === "cost_daily" || r.key === "cost_spike");
  let costDay: MetricsInput["costDay"] | undefined;
  if (needsCost) { try { costDay = await repo.costDay(env, tz, Math.max(...rules.filter((r) => r.key === "cost_spike").map((r) => Number(r.params.baseline_days ?? 7)), 7)); } catch { /* cost rules errored */ } }

  const evaluable: AlertRule[] = [];
  for (const r of rules) {
    const costRule = r.key === "cost_daily" || r.key === "cost_spike";
    const missingWindow = !windows[r.window_hours] && r.key !== "cost_daily";
    if ((costRule && !costDay) || missingWindow) { if (!errored.includes(r.key)) errored.push(r.key); continue; }
    evaluable.push(r);
  }
  const metrics: MetricsInput = { windows, costDay: costDay ?? { today: { faq: 0, partner: 0, total: 0 }, baseline_days: 0, baseline_avg: { faq: 0, partner: 0, total: 0 } } };
  const observations: Observation[] = evaluateAll(evaluable, metrics);
  const { transitions, next } = diffStates(prevStates, observations, nowIso);

  // Narrate first (needed for both dry-run preview and real events).
  const narrated = await Promise.all(transitions.map(async (t) => ({ t, n: await narrateTransition(t, deps.narrate) })));
  const digestNarr = await narrateDigest(observations, errored, deps.narrate);

  const result: EvaluateResult = {
    ok: true, slot, dryRun: Boolean(opts.dryRun),
    transitions: narrated.map(({ t, n }) => ({ kind: t.kind, rule_key: t.obs.rule.key, agent: t.obs.agent, subkey: t.obs.subkey, observed: t.obs.observed, threshold: t.obs.threshold, narrative: n.text })),
    digest: { sent: false, narrative: digestNarr.text },
    observations: observations.map((o) => ({ rule_key: o.rule.key, agent: o.agent, subkey: o.subkey, status: o.status, observed: o.observed, threshold: o.threshold, samples: o.samples, ...(o.note ? { note: o.note } : {}) })),
    errored,
  };
  if (opts.dryRun) return result;

  await repo.saveStates(next);
  const recipients = settings.email_recipients;
  const windowFrom = (t: Transition) => new Date(now.getTime() - t.obs.rule.window_hours * 3_600_000).toISOString();

  for (const [i, { t, n }] of narrated.entries()) {
    const ins = await repo.insertEvent({
      kind: t.kind, rule_key: t.obs.rule.key, agent: t.obs.agent, subkey: t.obs.subkey, severity: t.obs.rule.severity,
      observed: t.obs.observed, threshold: t.obs.threshold, samples: t.obs.samples, window_hours: t.obs.rule.window_hours,
      window_from: windowFrom(t), window_to: nowIso, narrative: n.text, narrative_source: n.source, run_slot: slot,
    });
    const d = await deliver(transitionMessage(t, n.text, url), { teams: true, email: true }, { ...deps.deliver, recipients });
    result.transitions[i].delivery = d;
    if (ins.id) await repo.updateEventDelivery(ins.id, d);
  }

  const ins = await repo.insertEvent({ kind: "digest", narrative: digestNarr.text, narrative_source: digestNarr.source, run_slot: slot });
  if (ins.inserted && settings.digest_enabled && opts.slot === "scheduled") {
    const d = await deliver(digestMessage(observations, errored, digestNarr.text, url), { teams: true, email: false }, { ...deps.deliver, recipients });
    result.digest = { sent: d.teams === "sent", narrative: digestNarr.text, delivery: d };
    if (ins.id) await repo.updateEventDelivery(ins.id, d);
  }
  return result;
}
```

- [ ] **Step 5: Write the route**

```ts
// app/api/monitoring/alerts/evaluate/route.ts
// Called by pg_cron (via pg_net) in the monitoring Supabase project. Bearer secret, not cookie:
// this is machine-to-machine. Secret unset ⇒ 404 (feature off), wrong ⇒ 401.
import { timingSafeEqual } from "node:crypto";
import { runEvaluation } from "@/lib/monitoring/alerts/evaluate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(req: Request, secret: string): boolean {
  const given = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!given || given.length !== secret.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(secret));
}

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.ALERT_EVALUATE_SECRET?.trim();
  if (!secret) return new Response(null, { status: 404 });
  if (!authorized(req, secret)) return Response.json({ detail: "Unauthorized" }, { status: 401 });
  let body: { slot?: string; dryRun?: boolean } = {};
  try { body = (await req.json()) as typeof body; } catch { /* empty body is fine */ }
  const slot = body.slot === "scheduled" || body.slot === "test" || body.slot === "manual" ? body.slot : "scheduled";
  try {
    const r = await runEvaluation({ slot, dryRun: Boolean(body.dryRun) });
    return r ? Response.json(r) : Response.json({ ok: false, skipped: "not configured" });
  } catch (e) {
    console.error("[alerts:evaluate] failed", { error: e instanceof Error ? e.message : "unknown" });
    return Response.json({ ok: false, detail: "evaluation failed" }, { status: 500 });
  }
}
```

Add to `.env.example` under the Monitoring block:
```
# Bearer secret pg_cron uses to call POST /api/monitoring/alerts/evaluate (openssl rand -hex 32).
# Unset ⇒ the endpoint returns 404 and no rule-based alerts run. Also stored in Supabase Vault.
ALERT_EVALUATE_SECRET=
# Optional: public origin used for "Dashboard öffnen" links in alerts (defaults to VERCEL_PROJECT_PRODUCTION_URL).
# ALERT_DASHBOARD_URL=
```

- [ ] **Step 6: Run tests + typecheck** — `npx vitest run tests/alerts-evaluate.test.ts && npm run typecheck` — Expected: PASS, no type errors.

- [ ] **Step 7: Smoke against the real DB (widget running on 3001, `ALERT_EVALUATE_SECRET=devsecret` in `.env.local`, restart dev server)**

```powershell
curl.exe -s -X POST http://127.0.0.1:3001/api/monitoring/alerts/evaluate -H "Authorization: Bearer devsecret" -H "Content-Type: application/json" -d '{"slot":"manual","dryRun":true}'
```
Expected: JSON with `"ok":true`, an `observations` array of ≥ 8 entries, `errored: []`. Without the header: HTTP 401.

- [ ] **Step 8: Commit**

```bash
git add lib/monitoring/alerts/repo.ts lib/monitoring/alerts/evaluate.ts app/api/monitoring/alerts/evaluate/route.ts tests/alerts-evaluate.test.ts .env.example
git commit -m "alerting: evaluation run, Supabase repo, bearer-gated evaluate endpoint"
```

---

### Task 7: pg_cron + pg_net scheduling and the live check

**Files:**
- Create: `supabase/migrations/20260915000200_alerting_cron.sql`
- Create: `scripts/alerts-verify.ts`
- Modify: `package.json` (add `"alerts:verify": "tsx scripts/alerts-verify.ts"`)

**Interfaces:**
- Produces SQL function `monitoring_call_evaluate(p_slot text) returns bigint` (pg_net request id) reading Vault secrets `alert_evaluate_url` and `alert_evaluate_secret`.
- Produces cron job `navio-alerts-test` (every 5 min) now; production jobs are added in Task 10.

- [ ] **Step 1: Create the two Vault secrets by hand** (Supabase SQL editor; values never go into git). Generate the secret with `openssl rand -hex 32`, set the same value as `ALERT_EVALUATE_SECRET` on Vercel (`navio-widget`, production + preview, sensitive) and in `.env.local`.

```sql
select vault.create_secret('https://navio-widget.vercel.app/api/monitoring/alerts/evaluate', 'alert_evaluate_url');
select vault.create_secret('<the hex secret>', 'alert_evaluate_secret');
```

- [ ] **Step 2: Write the migration**

```sql
-- Navio alerting — scheduler (spec §4 "Scheduling"). pg_cron runs in UTC; production jobs are
-- added in a later migration once the test job has been observed reaching Vercel.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
grant usage on schema cron to postgres;

create or replace function monitoring_call_evaluate(p_slot text) returns bigint
language plpgsql security definer set search_path = public, extensions, vault as $$
declare
  v_url text;
  v_secret text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'alert_evaluate_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'alert_evaluate_secret';
  if v_url is null or v_secret is null then
    raise notice 'alerting: vault secrets alert_evaluate_url / alert_evaluate_secret missing — skipped';
    return null;
  end if;
  return net.http_post(
    url := v_url,
    body := jsonb_build_object('slot', p_slot),
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret),
    timeout_milliseconds := 60000);
end $$;
revoke all on function monitoring_call_evaluate(text) from public, anon, authenticated;

-- Test cadence while building. Remove with: select cron.unschedule('navio-alerts-test');
select cron.schedule('navio-alerts-test', '*/5 * * * *', $$select monitoring_call_evaluate('test')$$);
```

- [ ] **Step 3: Apply and verify**

Apply with `mcp__supabase-monitoring__apply_migration` (`name: "alerting_cron"`). Then, after ≥ 6 minutes:

```sql
select jobname, schedule, active from cron.job;
select status, return_message, start_time from cron.job_run_details order by start_time desc limit 3;
select id, status_code, (content::text) from net._http_response order by id desc limit 3;
```
Expected: job `navio-alerts-test` active; run details `succeeded`; an `_http_response` row with `status_code = 200` and a body containing `"ok":true` (after the Vercel deploy from Task 6 is live with the secret; until then expect 404, which is the documented "feature off" answer).

- [ ] **Step 4: Write the live check**

```ts
// scripts/alerts-verify.ts — proves the whole loop against a RUNNING widget + the real Supabase:
// seed a breach → evaluate → event + Teams sent → clear → evaluate → recovered → evaluate → no-op.
//
//   npm run alerts:verify                 # EVE_HOST default http://127.0.0.1:3001
// Env: ALERT_EVALUATE_SECRET, MONITORING_SUPABASE_URL/_SERVICE_ROLE_KEY (from .env.local).
import "../lib/load-env.ts";
import { supabaseAdmin } from "../lib/monitoring/store.ts";

const host = process.env.EVE_HOST ?? "http://127.0.0.1:3001";
const secret = process.env.ALERT_EVALUATE_SECRET ?? "";
const db = supabaseAdmin();
if (!db || !secret) { console.error("Need MONITORING_SUPABASE_* and ALERT_EVALUATE_SECRET."); process.exit(2); }

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${label.padEnd(50)} ${detail}`); if (!ok) failures += 1; };
const SESSION = `alerts-verify-${Date.now()}`;

async function evaluate(slot: "test" | "manual" = "manual") {
  const res = await fetch(`${host}/api/monitoring/alerts/evaluate`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${secret}` }, body: JSON.stringify({ slot }) });
  return { status: res.status, body: (await res.json()) as { transitions: { kind: string; rule_key: string; agent: string; delivery?: { teams: string } }[]; digest: { sent: boolean } } };
}
async function seed(n: number, status: "failed" | "completed") {
  await db!.from("agent_sessions").upsert({ id: SESSION, agent: "faq" });
  const rows = Array.from({ length: n }, (_, i) => ({
    session_id: SESSION, agent: "faq", turn_id: `turn_${i}`, turn_index: i, status, started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(), duration_ms: 1000, user_input: "verify", metadata: { env: "production", verify: true },
  }));
  const { error } = await db!.from("traces").upsert(rows, { onConflict: "session_id,turn_id" });
  if (error) throw new Error(error.message);
}
async function cleanup() {
  await db!.from("traces").delete().eq("session_id", SESSION);
  await db!.from("agent_sessions").delete().eq("id", SESSION);
  const { data } = await db!.from("alert_rules").select("id").eq("key", "failure_rate").eq("agent", "all").maybeSingle();
  if (data) await db!.from("alert_state").delete().eq("rule_id", (data as { id: string }).id);
}

(async () => {
  try {
    // Unauthorized
    const unauth = await fetch(`${host}/api/monitoring/alerts/evaluate`, { method: "POST" });
    check("evaluate without bearer → 401", unauth.status === 401, String(unauth.status));

    // Baseline run so the state exists as ok (or breached from real traffic — we only assert on OUR transition).
    await evaluate("manual");

    // 1. seed a breach: 30 failed production traces → failure_rate total & faq breached
    await seed(30, "failed");
    const r1 = await evaluate("manual");
    const fired = r1.body.transitions.find((t) => t.kind === "fired" && t.rule_key === "failure_rate" && t.agent === "faq");
    check("breach fires failure_rate · faq", Boolean(fired), JSON.stringify(r1.body.transitions.map((t) => `${t.kind}:${t.rule_key}:${t.agent}`)));
    check("teams delivery attempted", fired?.delivery?.teams === "sent" || fired?.delivery?.teams === "skipped", fired?.delivery?.teams ?? "—");
    const { data: ev } = await db!.from("alert_events").select("id,kind,narrative_source").eq("kind", "fired").eq("rule_key", "failure_rate").eq("agent", "faq").order("created_at", { ascending: false }).limit(1);
    check("fired event row written", (ev?.length ?? 0) === 1, ev?.[0] ? `narrative=${(ev[0] as { narrative_source: string }).narrative_source}` : "");

    // 2. clear: mark them completed → recovered
    await seed(30, "completed");
    const r2 = await evaluate("manual");
    check("recovery transition", r2.body.transitions.some((t) => t.kind === "recovered" && t.rule_key === "failure_rate" && t.agent === "faq"));

    // 3. no-op
    const r3 = await evaluate("manual");
    check("third run: no transition", !r3.body.transitions.some((t) => t.rule_key === "failure_rate" && t.agent === "faq"));
    check("test/manual slot never sends the digest", r3.body.digest.sent === false);
  } catch (e) {
    check("script error", false, (e as Error).message);
  } finally {
    await cleanup();
  }
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
```

Add to `package.json` scripts: `"alerts:verify": "tsx scripts/alerts-verify.ts"`.

- [ ] **Step 5: Run it** — `npm run alerts:verify` with the widget on 3001. Expected: `ALL PASS` (7 checks) and one red + one green card in the Teams "Navio Alerts" channel (plus the email if Graph creds are in `.env.local`).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260915000200_alerting_cron.sql scripts/alerts-verify.ts package.json
git commit -m "alerting: pg_cron/pg_net scheduler via Vault and end-to-end live check"
```

---

### Task 8: Dashboard data API + auth scope

**Files:**
- Create: `lib/monitoring/alerts/query.ts`
- Create: `app/api/monitoring/alerts/events/route.ts`, `app/api/monitoring/alerts/rules/route.ts`, `app/api/monitoring/alerts/rules/[id]/route.ts`, `app/api/monitoring/alerts/settings/route.ts`, `app/api/monitoring/alerts/ack/route.ts`, `app/api/monitoring/alerts/test/route.ts`, `app/api/monitoring/alerts/run/route.ts`, `app/api/monitoring/alerts/status/route.ts`
- Modify: `lib/monitoring/auth.ts:70-74` (`isProtectedPath`), `middleware.ts:12-18` (matcher)
- Test: `tests/monitoring-auth.test.ts` (extend), `tests/alerts-query.test.ts`

**Interfaces:**
- query.ts:
  ```ts
  export interface AlertEventRow { id: string; kind: EventKind; rule_key: string|null; agent: string|null; subkey: string; severity: string|null; observed: number|null; threshold: number|null; samples: number|null; window_hours: number|null; window_from: string|null; window_to: string|null; narrative: string; narrative_source: string; delivery: Record<string,string>; run_slot: string; acknowledged_by: string|null; acknowledged_at: string|null; created_at: string }
  export function listAlertEvents(f: { kind?: string; agent?: string; cursor?: string; limit?: number }): Promise<{ items: AlertEventRow[]; nextCursor: string|null }>
  export function listAlertRules(): Promise<AlertRule[]>
  export function getAlertSettings(): Promise<AlertSettings>
  export function breachedStates(): Promise<{ rule_key: string; agent: string; subkey: string; observed: number|null; last_transition_at: string|null }[]>
  export const RulePatchSchema = z.object({ enabled: z.boolean().optional(), severity: z.enum(["warning","alert"]).optional(), threshold: z.number().nonnegative().optional(), window_hours: z.number().int().min(1).max(720).optional(), min_samples: z.number().int().min(0).optional() })
  export const SettingsPatchSchema = z.object({ email_recipients: z.array(z.string().email()).max(20).optional(), digest_enabled: z.boolean().optional() })
  export function parseEventFilters(p: URLSearchParams): { kind?: string; agent?: string; cursor?: string; limit?: number }
  ```
- Route contracts: `GET events?kind&agent&cursor&limit` → `{items,nextCursor}`; `GET rules` → `AlertRule[]`; `PATCH rules/:id` body `RulePatch` → updated rule; `GET|PATCH settings`; `POST ack {id, by}` → `{ok}`; `POST test` → `{delivery}`; `POST run {dryRun?}` → `EvaluateResult` (slot `manual`); `GET status` → `{ breached: [...], count }`.

- [ ] **Step 1: Failing tests**

Extend `tests/monitoring-auth.test.ts`:
```ts
it("alert data routes are protected; evaluate and the Langfuse relay are not", () => {
  expect(isProtectedPath("/api/monitoring/alerts/events")).toBe(true);
  expect(isProtectedPath("/api/monitoring/alerts/rules/abc")).toBe(true);
  expect(isProtectedPath("/api/monitoring/alerts/status")).toBe(true);
  expect(isProtectedPath("/api/monitoring/alerts/evaluate")).toBe(false);
  expect(isProtectedPath("/api/monitoring/alerts/faq")).toBe(false);
  expect(isProtectedPath("/api/monitoring/alerts/partner")).toBe(false);
});
```
New `tests/alerts-query.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { RulePatchSchema, SettingsPatchSchema, parseEventFilters } from "../lib/monitoring/alerts/query";

describe("alert patch schemas", () => {
  it("accepts a threshold change and rejects junk", () => {
    expect(RulePatchSchema.safeParse({ threshold: 0.2 }).success).toBe(true);
    expect(RulePatchSchema.safeParse({ threshold: -1 }).success).toBe(false);
    expect(RulePatchSchema.safeParse({ window_hours: 0 }).success).toBe(false);
    expect(RulePatchSchema.safeParse({ key: "cost_daily" }).success).toBe(true); // unknown keys ignored, not applied
    expect(Object.keys(RulePatchSchema.parse({ key: "x", enabled: false }))).toEqual(["enabled"]);
  });
  it("recipients must be emails", () => {
    expect(SettingsPatchSchema.safeParse({ email_recipients: ["a@b.de"] }).success).toBe(true);
    expect(SettingsPatchSchema.safeParse({ email_recipients: ["nope"] }).success).toBe(false);
  });
  it("event filters", () => {
    expect(parseEventFilters(new URLSearchParams("kind=fired&agent=faq&limit=10"))).toEqual({ kind: "fired", agent: "faq", limit: 10 });
    expect(parseEventFilters(new URLSearchParams("kind=bogus&limit=999"))).toEqual({ limit: 100 });
  });
});
```

- [ ] **Step 2: Run** — `npx vitest run tests/monitoring-auth.test.ts tests/alerts-query.test.ts` — Expected: FAIL.

- [ ] **Step 3: Auth + middleware**

`lib/monitoring/auth.ts` `isProtectedPath` becomes:
```ts
export function isProtectedPath(pathname: string): boolean {
  if (pathname === "/monitoring/login") return false;
  if (pathname === "/monitoring" || pathname.startsWith("/monitoring/")) return true;
  if (/^\/api\/monitoring\/(traces|stats|sessions)(\/|$)/.test(pathname)) return true;
  // Alert dashboard API — but NOT the machine endpoints: evaluate (bearer) and the Langfuse relay (HMAC).
  return /^\/api\/monitoring\/alerts\/(events|rules|settings|ack|test|run|status)(\/|$)/.test(pathname);
}
```
`middleware.ts` matcher: add
```ts
    "/api/monitoring/alerts/events",
    "/api/monitoring/alerts/rules",
    "/api/monitoring/alerts/rules/:path*",
    "/api/monitoring/alerts/settings",
    "/api/monitoring/alerts/ack",
    "/api/monitoring/alerts/test",
    "/api/monitoring/alerts/run",
    "/api/monitoring/alerts/status",
```

- [ ] **Step 4: query.ts**

```ts
// lib/monitoring/alerts/query.ts — read side + patch schemas for the alerts dashboard. Server-only.
import { z } from "zod";
import { supabaseAdmin } from "../store";
import type { AlertRule, EventKind } from "./types";
import type { AlertSettings } from "./repo";

export interface AlertEventRow {
  id: string; kind: EventKind; rule_key: string | null; agent: string | null; subkey: string; severity: string | null;
  observed: number | null; threshold: number | null; samples: number | null; window_hours: number | null;
  window_from: string | null; window_to: string | null; narrative: string; narrative_source: string;
  delivery: Record<string, string>; run_slot: string; acknowledged_by: string | null; acknowledged_at: string | null; created_at: string;
}
export interface EventFilters { kind?: string; agent?: string; cursor?: string; limit?: number }
const KINDS = new Set(["fired", "recovered", "digest", "test"]);
const AGENTS = new Set(["faq", "partner", "total"]);

export function parseEventFilters(p: URLSearchParams): EventFilters {
  const f: EventFilters = {};
  const kind = p.get("kind"); if (kind && KINDS.has(kind)) f.kind = kind;
  const agent = p.get("agent"); if (agent && AGENTS.has(agent)) f.agent = agent;
  const cursor = p.get("cursor"); if (cursor) f.cursor = cursor;
  const limit = Number(p.get("limit")); f.limit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : 100;
  return f;
}

export async function listAlertEvents(f: EventFilters): Promise<{ items: AlertEventRow[]; nextCursor: string | null }> {
  const db = supabaseAdmin();
  if (!db) return { items: [], nextCursor: null };
  const limit = f.limit ?? 50;
  let q = db.from("alert_events").select("*").order("created_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1);
  if (f.kind) q = q.eq("kind", f.kind);
  if (f.agent) q = q.eq("agent", f.agent);
  if (f.cursor) { const [cs, cid] = f.cursor.split("|"); if (cs && cid) q = q.or(`created_at.lt.${cs},and(created_at.eq.${cs},id.lt.${cid})`); }
  const { data, error } = await q;
  if (error || !data) return { items: [], nextCursor: null };
  const items = data.slice(0, limit) as AlertEventRow[];
  const last = items.at(-1);
  return { items, nextCursor: data.length > limit && last ? `${last.created_at}|${last.id}` : null };
}

export async function listAlertRules(): Promise<AlertRule[]> {
  const db = supabaseAdmin();
  if (!db) return [];
  const { data } = await db.from("alert_rules").select("*").order("key").order("agent");
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    id: String(r.id), key: r.key as AlertRule["key"], agent: r.agent as AlertRule["agent"], enabled: Boolean(r.enabled), severity: r.severity as AlertRule["severity"],
    threshold: Number(r.threshold), window_hours: Number(r.window_hours), min_samples: Number(r.min_samples), params: (r.params as Record<string, unknown>) ?? {}, description: String(r.description ?? ""),
  }));
}

export async function getAlertSettings(): Promise<AlertSettings> {
  const db = supabaseAdmin();
  if (!db) return { email_recipients: [], digest_enabled: true };
  const { data } = await db.from("alert_settings").select("*").eq("id", 1).maybeSingle();
  const s = data as { email_recipients?: string[]; digest_enabled?: boolean } | null;
  return { email_recipients: s?.email_recipients ?? [], digest_enabled: s?.digest_enabled ?? true };
}

export async function breachedStates(): Promise<{ rule_key: string; agent: string; subkey: string; observed: number | null; last_transition_at: string | null }[]> {
  const db = supabaseAdmin();
  if (!db) return [];
  const { data } = await db.from("alert_state").select("agent,subkey,observed,last_transition_at,alert_rules(key)").eq("status", "breached");
  return ((data ?? []) as unknown as { agent: string; subkey: string; observed: number | null; last_transition_at: string | null; alert_rules: { key: string } | null }[])
    .map((s) => ({ rule_key: s.alert_rules?.key ?? "?", agent: s.agent, subkey: s.subkey, observed: s.observed, last_transition_at: s.last_transition_at }));
}

export const RulePatchSchema = z.object({
  enabled: z.boolean().optional(),
  severity: z.enum(["warning", "alert"]).optional(),
  threshold: z.number().nonnegative().optional(),
  window_hours: z.number().int().min(1).max(720).optional(),
  min_samples: z.number().int().min(0).optional(),
});
export const SettingsPatchSchema = z.object({
  email_recipients: z.array(z.string().email()).max(20).optional(),
  digest_enabled: z.boolean().optional(),
});
```

- [ ] **Step 5: Routes** (each file starts with `export const runtime = "nodejs"; export const dynamic = "force-dynamic";` and guards with `if (!dashboardEnabled()) return new Response(null, { status: 404 });` — imported from `@/lib/monitoring/env`).

`events/route.ts`:
```ts
export async function GET(req: Request) { if (!dashboardEnabled()) return new Response(null, { status: 404 }); return Response.json(await listAlertEvents(parseEventFilters(new URL(req.url).searchParams))); }
```
`rules/route.ts`:
```ts
export async function GET() { if (!dashboardEnabled()) return new Response(null, { status: 404 }); return Response.json(await listAlertRules()); }
```
`rules/[id]/route.ts`:
```ts
import { supabaseAdmin } from "@/lib/monitoring/store";
import { RulePatchSchema } from "@/lib/monitoring/alerts/query";
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!dashboardEnabled()) return new Response(null, { status: 404 });
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ detail: "bad id" }, { status: 400 });
  const parsed = RulePatchSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ detail: "invalid", issues: parsed.error.issues }, { status: 400 });
  const db = supabaseAdmin();
  if (!db) return Response.json({ detail: "Unavailable" }, { status: 503 });
  const { data, error } = await db.from("alert_rules").update({ ...parsed.data, updated_at: new Date().toISOString() }).eq("id", id).select("*").maybeSingle();
  if (error) return Response.json({ detail: error.message }, { status: 500 });
  return data ? Response.json(data) : new Response(null, { status: 404 });
}
```
`settings/route.ts`: `GET` returns `getAlertSettings()`; `PATCH` validates with `SettingsPatchSchema`, then `db.from("alert_settings").update({ ...parsed.data, updated_at }).eq("id", 1).select("*").maybeSingle()`.

`ack/route.ts`:
```ts
export async function POST(req: Request) {
  if (!dashboardEnabled()) return new Response(null, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { id?: string; by?: string };
  if (!body.id || !/^[0-9a-f-]{36}$/i.test(body.id)) return Response.json({ detail: "bad id" }, { status: 400 });
  const by = (body.by ?? "").trim().slice(0, 60) || "Team";
  const db = supabaseAdmin();
  if (!db) return Response.json({ detail: "Unavailable" }, { status: 503 });
  const { error } = await db.from("alert_events").update({ acknowledged_by: by, acknowledged_at: new Date().toISOString() }).eq("id", body.id);
  return error ? Response.json({ detail: error.message }, { status: 500 }) : Response.json({ ok: true });
}
```
`test/route.ts`:
```ts
import { deliver, testMessage } from "@/lib/monitoring/alerts/deliver";
import { dashboardUrl } from "@/lib/monitoring/alerts/evaluate";
import { getAlertSettings } from "@/lib/monitoring/alerts/query";
import { supabaseAdmin } from "@/lib/monitoring/store";
export async function POST() {
  if (!dashboardEnabled()) return new Response(null, { status: 404 });
  const settings = await getAlertSettings();
  const msg = testMessage(dashboardUrl());
  const delivery = await deliver(msg, { teams: true, email: true }, { recipients: settings.email_recipients });
  const db = supabaseAdmin();
  if (db) await db.from("alert_events").insert({ kind: "test", narrative: msg.detail, narrative_source: "template", delivery, run_slot: `test:${new Date().toISOString()}` });
  return Response.json({ delivery });
}
```
`run/route.ts`:
```ts
import { runEvaluation } from "@/lib/monitoring/alerts/evaluate";
export const maxDuration = 60;
export async function POST(req: Request) {
  if (!dashboardEnabled()) return new Response(null, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { dryRun?: boolean };
  const r = await runEvaluation({ slot: "manual", dryRun: Boolean(body.dryRun) });
  return r ? Response.json(r) : Response.json({ detail: "Unavailable" }, { status: 503 });
}
```
`status/route.ts`:
```ts
export async function GET() { if (!dashboardEnabled()) return new Response(null, { status: 404 }); const breached = await breachedStates(); return Response.json({ breached, count: breached.length }); }
```

- [ ] **Step 6: Run** — `npx vitest run && npm run typecheck` — Expected: all green.

- [ ] **Step 7: Manual check** (dev server restarted, logged in at `/monitoring/login`):
`curl.exe -s http://127.0.0.1:3001/api/monitoring/alerts/rules` → 401 without cookie; in the browser `/api/monitoring/alerts/rules` → JSON of 8 rules; `/api/monitoring/alerts/status` → `{"breached":[],"count":0}` (or the live breaches).

- [ ] **Step 8: Commit**

```bash
git add lib/monitoring/alerts/query.ts app/api/monitoring/alerts lib/monitoring/auth.ts middleware.ts tests/monitoring-auth.test.ts tests/alerts-query.test.ts
git commit -m "alerting: dashboard data API (events, rules, settings, ack, test, run, status)"
```

---

### Task 9: `/monitoring/alerts` page, nav entry, overview banner

**Files:**
- Create: `components/monitoring/alerts-format.ts` (pure helpers: `fmtRuleValue`, `severityTone`, `kindLabel`)
- Create: `components/monitoring/AlertFeed.tsx` (client: list + filters + acknowledge)
- Create: `components/monitoring/AlertRules.tsx` (client: rules table, settings, run/test buttons)
- Create: `app/monitoring/alerts/page.tsx` (server: loads events/rules/settings, tabs)
- Create: `components/monitoring/BreachBanner.tsx` (server)
- Modify: `components/monitoring/HeaderNav.tsx` (add "Alerts" link + red dot), `app/monitoring/page.tsx` (banner under PageHeader)
- Test: `tests/alerts-format.test.ts`

**Interfaces:**
- alerts-format.ts:
  ```ts
  export function fmtRuleValue(key: string, v: number | string | null): string  // same output as narrate.fmtValue but tolerant of Postgres numeric strings
  export function kindLabel(kind: string): string   // fired→"Alarm", recovered→"Entwarnung", digest→"Digest", test→"Test"
  export function severityTone(kind: string, severity: string | null): "red" | "warn" | "green" | "muted"
  export function ruleLabel(key: string, agent: string | null, subkey: string): string  // mirrors narrate.ruleTitle
  ```

- [ ] **Step 1: Failing test**

```ts
// tests/alerts-format.test.ts
import { describe, it, expect } from "vitest";
import { fmtRuleValue, kindLabel, severityTone, ruleLabel } from "../components/monitoring/alerts-format";

describe("alerts dashboard formatters", () => {
  it("values", () => {
    expect(fmtRuleValue("failure_rate", "0.15")).toBe("15 %");
    expect(fmtRuleValue("latency_p95", 8400)).toBe("8,4 s");
    expect(fmtRuleValue("cost_daily", "1.6")).toBe("1,60 $");
    expect(fmtRuleValue("error_repeat", 6)).toBe("6×");
    expect(fmtRuleValue("failure_rate", null)).toBe("—");
  });
  it("labels and tones", () => {
    expect(kindLabel("fired")).toBe("Alarm");
    expect(severityTone("fired", "alert")).toBe("red");
    expect(severityTone("fired", "warning")).toBe("warn");
    expect(severityTone("recovered", "alert")).toBe("green");
    expect(severityTone("digest", null)).toBe("muted");
    expect(ruleLabel("error_repeat", "total", "azure_429")).toBe("Wiederholter Fehler azure_429 · Gesamt");
  });
});
```

- [ ] **Step 2: Run** — `npx vitest run tests/alerts-format.test.ts` — FAIL.

- [ ] **Step 3: alerts-format.ts**

```ts
// components/monitoring/alerts-format.ts — pure, testable (no JSX in vitest). Re-exports narrate's
// formatting so the dashboard and the messages can never disagree on a number.
import { fmtValue, ruleTitle } from "@/lib/monitoring/alerts/narrate";
import type { ObsAgent, RuleKey } from "@/lib/monitoring/alerts/types";

export function fmtRuleValue(key: string, v: number | string | null): string {
  if (v === null || v === undefined || v === "") return "—";
  const n = typeof v === "string" ? Number(v) : v;
  if (!Number.isFinite(n)) return "—";
  return fmtValue(key as RuleKey, n);
}
export function kindLabel(kind: string): string {
  return kind === "fired" ? "Alarm" : kind === "recovered" ? "Entwarnung" : kind === "digest" ? "Digest" : "Test";
}
export function severityTone(kind: string, severity: string | null): "red" | "warn" | "green" | "muted" {
  if (kind === "recovered") return "green";
  if (kind === "fired") return severity === "warning" ? "warn" : "red";
  return "muted";
}
export function ruleLabel(key: string, agent: string | null, subkey: string): string {
  return ruleTitle(key as RuleKey, (agent ?? "total") as ObsAgent, subkey);
}
```

- [ ] **Step 4: Run** — PASS. Then build the UI (not unit-tested; reviewed in the browser).

`components/monitoring/BreachBanner.tsx`:
```tsx
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { breachedStates } from "@/lib/monitoring/alerts/query";
import { ruleLabel } from "./alerts-format";

export async function BreachBanner() {
  const breached = await breachedStates();
  if (breached.length === 0) return null;
  return (
    <Link href="/monitoring/alerts" className="flex items-start gap-3 rounded-2xl border border-(--red)/40 bg-(--red)/8 px-4 py-3 text-sm text-(--fg) transition-colors hover:bg-(--red)/12">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-(--red)" aria-hidden />
      <span>
        <span className="font-display font-semibold">{breached.length} Regel{breached.length === 1 ? "" : "n"} verletzt</span>
        <span className="text-(--fg-muted)"> — {breached.slice(0, 3).map((b) => ruleLabel(b.rule_key, b.agent, b.subkey)).join(", ")}{breached.length > 3 ? " …" : ""}</span>
      </span>
    </Link>
  );
}
```
In `app/monitoring/page.tsx` import it and render `<BreachBanner />` directly under `<PageHeader … />`.

`components/monitoring/HeaderNav.tsx`: add a second `<Link href="/monitoring/alerts">Alerts</Link>` styled like Overview (active when `pathname.startsWith("/monitoring/alerts")`), and a small red dot: the component fetches `/api/monitoring/alerts/status` once on mount (`useEffect` + `useState<number>(0)`, ignore errors) and renders `<span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-(--red)" aria-label="Regeln verletzt" />` when `count > 0`.

`app/monitoring/alerts/page.tsx`:
```tsx
// Alerts: feed of fired/recovered/digest/test events + editable rules and recipients.
import { Suspense } from "react";
import { PageHeader } from "@/components/monitoring/PageHeader";
import { AlertFeed } from "@/components/monitoring/AlertFeed";
import { AlertRules } from "@/components/monitoring/AlertRules";
import { getAlertSettings, listAlertEvents, listAlertRules, parseEventFilters } from "@/lib/monitoring/alerts/query";

export const dynamic = "force-dynamic";

export default async function AlertsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = new URLSearchParams(Object.entries(await searchParams).flatMap(([k, v]) => (typeof v === "string" ? [[k, v] as [string, string]] : [])));
  const tab = sp.get("tab") === "rules" ? "rules" : "feed";
  const [events, rules, settings] = await Promise.all([listAlertEvents(parseEventFilters(sp)), listAlertRules(), getAlertSettings()]);
  return (
    <div className="space-y-6">
      <PageHeader title="Alerts" description="Regelbasierte Alarme aus den Monitoring-Daten — zweimal täglich ausgewertet, Meldungen an Teams und E-Mail." />
      <nav aria-label="Tabs" className="flex gap-1">
        {(["feed", "rules"] as const).map((t) => (
          <a key={t} href={`/monitoring/alerts?tab=${t}`} aria-current={tab === t ? "page" : undefined}
            className={`rounded-full px-3 py-1.5 font-display text-sm font-medium ${tab === t ? "bg-(--surface-muted) text-(--fg)" : "text-(--fg-muted) hover:bg-(--surface-muted)"}`}>
            {t === "feed" ? "Feed" : "Regeln"}
          </a>
        ))}
      </nav>
      <Suspense fallback={null}>
        {tab === "feed" ? <AlertFeed initial={events} params={sp} /> : <AlertRules rules={rules} settings={settings} />}
      </Suspense>
    </div>
  );
}
```

`components/monitoring/AlertFeed.tsx` (client): props `{ initial: { items: AlertEventRow[]; nextCursor: string | null }; params: URLSearchParams }`. Renders a filter row (kind select: Alle/Alarm/Entwarnung/Digest/Test; agent select: Alle/FAQ/Partner/Gesamt; plain GET form to `/monitoring/alerts` keeping `tab=feed`), then a `Card` list. Each row: left border coloured by `severityTone` (`border-l-4 border-(--red)` / `border-(--warn-icon)` / `border-(--brand-green)` / `border-(--border)`), header line = `kindLabel` pill + `ruleLabel` + `fmtTime(created_at)`; fact line = `Wert {fmtRuleValue(rule_key, observed)} · Grenze {fmtRuleValue(rule_key, threshold)} · Fenster {window_hours} h · Turns {samples}` (omitted for digest/test); narrative in `<p className="whitespace-pre-line">` collapsed to 3 lines with a "Mehr" toggle for digests; delivery chips `Teams: sent` (green) / `failed: …` (red) / `skipped` (muted) and `E-Mail: …`; a link "Traces ansehen" to `/monitoring?agent=<faq|partner>&from=<window_from>&to=<window_to>` when agent is faq/partner and window_from is set; right side an **Bestätigen** button (`BTN_SECONDARY`) → `POST /api/monitoring/alerts/ack` with `{ id, by }` where `by` comes from `localStorage["navio_monitoring_name"]` or a `window.prompt("Dein Name")` on first use; after success the row shows `✓ {acknowledged_by} · {fmtTime(acknowledged_at)}` and the button disappears. "Mehr laden" button appends the next page via `GET /api/monitoring/alerts/events?cursor=…`.

`components/monitoring/AlertRules.tsx` (client): props `{ rules: AlertRule[]; settings: AlertSettings }`. Top `Card` "Aktionen" with three buttons: **Vorschau auswerten** (`POST /api/monitoring/alerts/run` `{dryRun:true}`, shows the returned `observations` as a compact table: rule, agent, status pill, value, threshold, note, and `transitions` that would fire), **Jetzt auswerten** (`{dryRun:false}`, then `router.refresh()`), **Testalarm senden** (`POST /api/monitoring/alerts/test`, shows delivery result inline). Second `Card` "Empfänger": textarea of comma-separated emails + "Digest an Teams" checkbox, **Speichern** → `PATCH /api/monitoring/alerts/settings`; empty list shows the hint "Leer ⇒ Fallback ALERT_EMAIL_TO". Third `Card` "Regeln": table (horizontal scroll container on mobile) with columns Regel (`ruleLabel(key, agent==='all' ? null : agent, '')` + description), Aktiv (checkbox), Schwere (select warning/alert), Grenze (number input, step by key: 0.01 for rates and cost, 100 for ms, 1 for counts, 0.1 for spike), Fenster h (number), Min. Turns (number), and a per-row **Speichern** (`PATCH /api/monitoring/alerts/rules/:id`) that shows a ✓ for 2 s. Unit hints under Grenze: `%` shown as `0.10 = 10 %`. All inputs use `INPUT`/`SELECT`, buttons `BTN_PRIMARY`/`BTN_SECONDARY`.

- [ ] **Step 5: Browser pass** with the dev server: open `/monitoring/alerts` at 375, 768, 1440 and in dark mode; run "Vorschau auswerten", "Jetzt auswerten", "Testalarm senden"; change a threshold and save; acknowledge an event; confirm the overview shows the banner when a rule is breached (temporarily set `failure_rate` threshold to 0 and min_samples to 0, run, check banner + red dot, then restore 0.10 / 10 and run again to see the recovery). Fix anything that overflows horizontally.

- [ ] **Step 6: `npm run typecheck && npm test`** — green.

- [ ] **Step 7: Commit**

```bash
git add components/monitoring/alerts-format.ts components/monitoring/AlertFeed.tsx components/monitoring/AlertRules.tsx components/monitoring/BreachBanner.tsx components/monitoring/HeaderNav.tsx app/monitoring/alerts/page.tsx app/monitoring/page.tsx tests/alerts-format.test.ts
git commit -m "alerting: /monitoring/alerts page (feed, rules, recipients), nav entry, breach banner"
```

---

### Task 10: Docs, production schedule, go-live

**Files:**
- Modify: `docs/MONITORING-ALERTING.md` (new section "Supabase rules (2026-09-15)")
- Modify: `docs/MONITORING.md` §4 (one paragraph on the Alerts page) and §6 Operations (`alerts:verify`, unschedule/reschedule lines)
- Create: `supabase/migrations/20260915000300_alerting_cron_production.sql`
- Modify: `CortexKit/CLAUDE.md` §17 (one bullet pointing at the alerting section and the two migrations)

- [ ] **Step 1: Write the docs section** in `docs/MONITORING-ALERTING.md`, covering: what runs where (pg_cron → pg_net → evaluate → rules → Teams/email), the 7 rules and their defaults, transition-only policy, digest behaviour, Vault secret names, `ALERT_EVALUATE_SECRET`, the DST note (`0 5` / `0 13` UTC = 07:00 / 15:00 CEST; in winter run `select cron.alter_job(job_id, schedule := '0 6 * * *')` / `'0 14 * * *'`), how to read `cron.job_run_details` and `net._http_response`, and the go-live checklist below.

- [ ] **Step 2: Production cron migration** (apply only after the test job has produced a `status_code = 200` response from Vercel):

```sql
-- Production cadence (spec §4): 07:00 and 15:00 Europe/Berlin, written for CEST (UTC+2).
select cron.schedule('navio-alerts-morning',   '0 5 * * *',  $$select monitoring_call_evaluate('scheduled')$$);
select cron.schedule('navio-alerts-afternoon', '0 13 * * *', $$select monitoring_call_evaluate('scheduled')$$);
-- Remove the build-time test cadence.
select cron.unschedule('navio-alerts-test');
```

- [ ] **Step 3: Go-live checklist** (execute and tick):
  1. `ALERT_EVALUATE_SECRET` set on Vercel `navio-widget` (production + preview, sensitive) and equal to Vault `alert_evaluate_secret`.
  2. Widget redeployed; `curl -X POST https://navio-widget.vercel.app/api/monitoring/alerts/evaluate -H "Authorization: Bearer …" -d '{"slot":"manual","dryRun":true}'` returns `ok:true`.
  3. `net._http_response` shows 200 from the test job.
  4. Apply `…000300_alerting_cron_production.sql`; `select jobname from cron.job` lists morning + afternoon only.
  5. Set real recipients in the dashboard (Regeln → Empfänger).
  6. Next morning: the 07:00 digest is in Teams and visible in the feed with `run_slot = <date>T07`.

- [ ] **Step 4: Update CLAUDE.md §17** with one bullet: "Alerting (2026-09-15): rules in `alert_rules`, evaluator `lib/monitoring/alerts/*`, cron in Supabase (`monitoring_call_evaluate`), docs `docs/MONITORING-ALERTING.md` § Supabase rules. Email = Microsoft Graph, not Resend."

- [ ] **Step 5: Commit**

```bash
git add docs/MONITORING-ALERTING.md docs/MONITORING.md supabase/migrations/20260915000300_alerting_cron_production.sql
git commit -m "alerting: docs, production schedule, go-live checklist"
```
(`CLAUDE.md` is gitignored — edit it, do not try to add it.)

---

## Self-review

- **Spec coverage:** §4 tables/seed/cron → Tasks 1, 7, 10. §5 evaluator, dry run, idempotent digest, parallel per-rule errors → Task 6. §6 narration, FactSet card, digest Teams-only + scheduled-only, recipients fallback → Tasks 4, 5, 6. §7 feed/ack/rules/settings/preview/run/test/banner/nav → Tasks 8, 9. §8 config → Tasks 6, 7, 10. §9 invariants → Task 6 tests (errored rule, delivery failure, no repo). §10 unit + live check → Tasks 2–7. §11 order matches Tasks 1–10.
- **Type consistency:** `Observation`, `Transition`, `AlertStateRow` defined in Task 2 and used unchanged in 3–6; `Delivery` from Task 5 used in Task 6 repo; `AlertSettings` exported from repo.ts (Task 6) and imported by query.ts (Task 8); `fmtValue`/`ruleTitle` exported from narrate.ts (Task 4) and reused in deliver.ts (5) and alerts-format.ts (9).
- **Placeholders:** none; every code step is complete. UI components in Task 9 are described in full behavioural detail rather than as code, because they are not unit-tested and follow existing `.tsx` patterns in the folder.
