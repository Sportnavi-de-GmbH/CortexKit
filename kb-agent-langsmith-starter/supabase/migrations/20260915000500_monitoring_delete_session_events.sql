-- Navio monitoring — delete RPC follow-up (spec docs/superpowers/specs/2026-09-15-navio-monitoring-delete-design.md §3)
-- Same signature/return as 20260915000400: when a session ends up deleted (its last trace went),
-- also remove that session's `events` rows (session-scoped, trace_id null) and its `feedback`
-- rows (unlinked votes, trace_id null) so nothing dangles behind a session that no longer exists.

create or replace function monitoring_delete_traces(p_ids uuid[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_sessions text[]; v_deleted_sessions text[]; v_traces int; v_feedback int; v_events int; v_sessions_deleted int; v_n int;
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
  with gone as (
    delete from agent_sessions where id = any(v_sessions) and turn_count = 0 returning id
  ) select array_agg(id) into v_deleted_sessions from gone;
  v_sessions_deleted := coalesce(array_length(v_deleted_sessions, 1), 0);
  if v_sessions_deleted > 0 then
    delete from events   where session_id = any(v_deleted_sessions); get diagnostics v_n = row_count; v_events   := v_events   + v_n;
    delete from feedback where session_id = any(v_deleted_sessions); get diagnostics v_n = row_count; v_feedback := v_feedback + v_n;
  end if;
  return jsonb_build_object('traces', v_traces, 'feedback', v_feedback, 'events', v_events, 'sessions_deleted', v_sessions_deleted);
end $$;

revoke all on function monitoring_delete_traces(uuid[]) from public, anon, authenticated;
