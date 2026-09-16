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
