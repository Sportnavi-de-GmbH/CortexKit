# Navio monitoring — deleting traces and alerts from the dashboard

**Date:** 2026-09-15 · **Branch:** `alerting` · **Status:** approved design

## 1. Goal

The team can delete executions (traces) and alert events from `/monitoring`, singly or in bulk,
and everything that depends on them (steps, errors, votes, session counters, KPI tiles, charts,
the breach banner, alert state) is removed or recomputed in the same action. No stale value
anywhere after a deletion.

## 2. Decisions

| Question | Decision |
|---|---|
| UI | per-row trash icon + checkbox column + "N ausgewählt · Löschen" bar on the traces list and the alert feed; "Löschen" on the trace detail page; one confirm dialog naming what goes; no undo |
| Cascade for a trace | `trace_steps`, `errors` (FK cascade); `feedback` and `events` rows of that trace deleted explicitly; `agent_sessions.turn_count`/`last_seen_at` recomputed; sessions left empty are deleted |
| Cascade for an alert event | only the row; `alert_state` is untouched (state = current truth, event = history) |
| Alert sync after trace deletion | the route triggers `runEvaluation({ slot: "manual" })` in the background; recoveries are delivered normally |
| UI sync | after every delete: `router.refresh()` (re-renders all server components) + header status re-fetch; no optimistic local state |

## 3. Data layer (one migration, `20260915000400_monitoring_delete.sql`)

```sql
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
```

## 4. API (cookie-gated like the rest of the dashboard API)

| Route | Body | Response |
|---|---|---|
| `DELETE /api/monitoring/traces` | `{ ids: uuid[] }` 1–200 | `{ deleted: n, feedback, events, sessions_deleted, reevaluate: "started" \| "pending" \| "skipped" \| "failed" }` |
| `DELETE /api/monitoring/traces/:id` | — | same shape, `deleted` 0 or 1 |
| `DELETE /api/monitoring/alerts/events` | `{ ids: uuid[] }` 1–200 | `{ deleted: n }` |
| `DELETE /api/monitoring/alerts/events/:id` | — | `{ deleted: 0 \| 1 }` |

Validation: uuid regex per id, 400 on invalid/empty/too many, 404 when the dashboard is disabled,
503 when Supabase is unconfigured, 500 with `{ detail }` on an RPC error. `isProtectedPath` and
the middleware matcher gain `/api/monitoring/alerts/events/:path*` (the collection path is already
covered).

Re-evaluation: `lib/monitoring/delete.ts` `deleteTraces(ids)` calls the RPC, then starts
`runEvaluation({ slot: "manual" })` without awaiting beyond a 5 s cap (`Promise.race`); failures
are logged (error name + message ≤200 chars — infra, not visitor text) and never fail the delete.
`ALERT_EVALUATE_SECRET` is not needed (in-process call). `reevaluate` is `started` (finished within
the cap), `pending` (still running past the cap, kept alive with Next's `after()`; the UI refreshes
once more after 8 s), `skipped` (Supabase alert repo unconfigured) or `failed` (it threw). The
evaluation persists `alert_state` before narrating, so the breach truth is current within seconds
regardless of narration/delivery time.

## 5. UI

- `components/monitoring/TraceList.tsx` becomes a client component. New first column: checkbox
  (`aria-label` "Ausführung auswählen"), header checkbox selects all shown rows. New last-column
  trash icon button (`ICON_BTN`, lucide `Trash2`, `aria-label` "Ausführung löschen"). Row link
  keeps the stretched-anchor pattern; the checkbox and trash sit above it (`relative z-10`).
- `components/monitoring/DeleteBar.tsx` (client, shared): sticky bar shown while `selected.size >
  0`: "N ausgewählt" · "Auswahl aufheben" · "Löschen" (`BTN_PRIMARY` in red tone `bg-(--red)`).
- `components/monitoring/ConfirmDialog.tsx` (client, shared): native `<dialog>`; title, body,
  "Abbrechen"/"Endgültig löschen"; focus trapped by the element; Escape closes.
  Trace body: "{n} Ausführung(en) samt Schritten, Fehlern und Bewertungen werden endgültig
  gelöscht. Leere Sitzungen werden ebenfalls entfernt." Alert body: "{n} Meldung(en) werden
  endgültig gelöscht. Der aktuelle Alarmstatus bleibt unverändert."
- Trace detail page: "Löschen" button in `PageHeader.actions` (client island
  `DeleteTraceButton`), on success `router.push("/monitoring")` + `router.refresh()`.
- Session page: the trace rows get the same per-row trash via the shared list component.
- Alert feed: checkbox + trash per row, same bar and dialog.
- `HeaderNav` red dot: re-fetches `/api/monitoring/alerts/status` on `pathname` change and on a
  `window` event `navio:refresh` that the delete flows dispatch after `router.refresh()`.
- Errors: inline red text "Löschen fehlgeschlagen – bitte erneut versuchen." with the raw detail
  in a collapsed line; the selection is kept so the user can retry.

## 6. Testing

- vitest: `tests/monitoring-delete.test.ts` — id validation (`parseIds`), `deleteTraces` with a
  stubbed client (RPC called with the ids, evaluator started, evaluator failure swallowed,
  unconfigured ⇒ `skipped`), `deleteAlertEvents`; `tests/monitoring-auth.test.ts` gains the new
  path; a pure `selection.ts` helper (toggle/all/none) tested.
- live: `npm run monitoring:verify` gains a "delete" section: seed a throwaway session with 2
  traces + 1 vote, delete one trace via the API ⇒ session `turn_count` 1; delete the other ⇒
  session gone, no orphan feedback/steps/errors; seed and delete an alert event.
- browser: overview → select 2 → delete → tiles/bars/table update without reload; trace detail →
  delete → back on overview; alerts feed → delete → row gone, red dot/banner consistent.
