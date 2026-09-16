-- Navio monitoring — delete RPCs (spec docs/superpowers/specs/2026-09-15-navio-monitoring-delete-design.md §3)

create or replace function monitoring_delete_traces(p_ids uuid[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_sessions text[]; v_traces int; v_feedback int; v_events int; v_sessions_deleted int;
begin
  select array_agg(distinct session_id) into v_sessions from traces where id = any(p_ids);
  delete from feedback where trace_id = any(p_ids);              get diagnostics v_feedback = row_count;
  delete from events   where trace_id = any(p_ids);              get diagnostics v_events = row_count;
  delete from traces   where id = any(p_ids);                    get diagnostics v_traces = row_count;
  -- steps + errors cascade by FK
  update agent_sessions s set
    turn_count   = coalesce((select count(*) from traces t where t.session_id = s.id), 0),
    last_seen_at = coalesce((select max(started_at) from traces t where t.session_id = s.id), s.first_seen_at)
  where s.id = any(v_sessions);
  delete from agent_sessions where id = any(v_sessions) and turn_count = 0;
  get diagnostics v_sessions_deleted = row_count;
  return jsonb_build_object('traces', v_traces, 'feedback', v_feedback, 'events', v_events, 'sessions_deleted', v_sessions_deleted);
end $$;

create or replace function monitoring_delete_alert_events(p_ids uuid[]) returns int
language plpgsql security definer set search_path = public as $$
declare v int; begin delete from alert_events where id = any(p_ids); get diagnostics v = row_count; return v; end $$;

revoke all on function monitoring_delete_traces(uuid[]) from public, anon, authenticated;
revoke all on function monitoring_delete_alert_events(uuid[]) from public, anon, authenticated;
