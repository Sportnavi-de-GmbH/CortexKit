# Monitoring Delete (traces + alerts) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete traces and alert events from `/monitoring` (single + bulk, confirmed), cascading to every dependent row and re-syncing the dashboard and alert state.

**Architecture:** Two Postgres RPCs do the cascade in one transaction; a small server module `lib/monitoring/delete.ts` validates ids, calls the RPCs, and kicks a background `runEvaluation` after trace deletions; DELETE routes under `/api/monitoring/*` are cookie-gated; three shared client components (`ConfirmDialog`, `DeleteBar`, `useDeleteFlow`) power the traces list, trace detail, session page and alert feed; every flow ends with `router.refresh()` + a `navio:refresh` window event.

**Tech Stack:** Next 15 app router (server + client components), Supabase RPC, zod, vitest, lucide, existing `ui.tsx` primitives.

**Spec:** `docs/superpowers/specs/2026-09-15-navio-monitoring-delete-design.md`

## Global Constraints

- Paths relative to `kb-agent-langsmith-starter/`; branch `alerting`; unrelated uncommitted files (agent/instructions.md, agent/prompts/*, partner-recommendation-agent-v2/, evaluation-platform spec, CSV) are never staged; `.env.local` never.
- Missing config ⇒ no-op/503, never a throw; dashboard disabled ⇒ 404.
- vitest has no JSX transform: logic in `.ts`.
- UI: `ui.tsx` primitives, lucide only, German copy consistent with the alerts page, responsive 375–1440, dark mode; red = destructive (`--red`), no new colour.
- Commit messages carry NO Co-Authored-By / Anthropic line (CLAUDE.md §13 overrides the harness default).
- `npm run typecheck` and `npm test` green before each commit. Never run `npm run alerts:verify` (posts to Teams).

---

### Task 1: Migration — delete RPCs

**Files:** Create `supabase/migrations/20260915000400_monitoring_delete.sql`; modify `docs/MONITORING.md` §3 (add to the migration list).

**Interfaces:** `monitoring_delete_traces(p_ids uuid[]) returns jsonb {traces, feedback, events, sessions_deleted}`; `monitoring_delete_alert_events(p_ids uuid[]) returns int`.

- [ ] Write the migration exactly as in spec §3 (both functions + revokes). Add a header comment naming the spec.
- [ ] Apply with `mcp__supabase-monitoring__apply_migration` (name `monitoring_delete`).
- [ ] Verify with `execute_sql` using a throwaway session: insert `agent_sessions('verify-del', 'faq')`, two `traces` (`session_id='verify-del'`, `turn_id` `t0`/`t1`, `status='completed'`, `metadata '{"env":"development"}'`), one `trace_steps` row on t0, one `errors` row on t0, one `feedback` row on t0; call `monitoring_delete_traces(array[<t0 id>])` ⇒ `traces:1, feedback:1`; assert `agent_sessions.turn_count = 1`, no steps/errors for t0; call with `[<t1 id>]` ⇒ `sessions_deleted:1`; assert the session is gone. Insert an `alert_events` row (`kind 'test'`, `narrative 'x'`, `narrative_source 'template'`, `run_slot 'verify'`) and delete it via the second RPC ⇒ 1. Record every query and result in the report.
- [ ] Update `docs/MONITORING.md` §3 step 1 list (append `…20260915000400_monitoring_delete.sql`).
- [ ] Commit: `monitoring: delete RPCs for traces (with cascade + session resync) and alert events`.

---

### Task 2: Server module + DELETE routes + auth scope

**Files:** Create `lib/monitoring/delete.ts`; create `app/api/monitoring/alerts/events/[id]/route.ts`; modify `app/api/monitoring/traces/route.ts`, `app/api/monitoring/traces/[id]/route.ts`, `app/api/monitoring/alerts/events/route.ts` (add `DELETE` handlers); modify `lib/monitoring/auth.ts` `isProtectedPath` + `middleware.ts` matcher (add `/api/monitoring/alerts/events/:path*`); tests `tests/monitoring-delete.test.ts`, extend `tests/monitoring-auth.test.ts`.

**Interfaces (delete.ts):**
```ts
export const IdsSchema = z.object({ ids: z.array(z.string().regex(UUID)).min(1).max(200) });
export function parseIds(body: unknown): string[] | null;          // null on invalid
export interface DeleteDeps { client?: { rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }> }; reevaluate?: () => Promise<unknown>; reevaluateCapMs?: number; log?: (line: string, shape: Record<string, unknown>) => void }
export interface DeleteTracesResult { deleted: number; feedback: number; events: number; sessions_deleted: number; reevaluate: "started" | "skipped" | "failed" }
export function deleteTraces(ids: string[], deps?: DeleteDeps): Promise<DeleteTracesResult | undefined>;   // undefined when no client
export function deleteAlertEvents(ids: string[], deps?: DeleteDeps): Promise<{ deleted: number } | undefined>;
```
Default `client` = `supabaseAdmin()`; default `reevaluate` = `() => runEvaluation({ slot: "manual" })` (dynamic import to keep this module light); `deleteTraces` awaits `Promise.race([reevaluate(), timeout(reevaluateCapMs ?? 5000)])` in a try/catch: resolved ⇒ `"started"` (name kept for the API contract), rejected ⇒ `"failed"` + shape-only log, no repo (runEvaluation returns undefined) ⇒ `"skipped"`. An RPC error throws `Error(message)`; routes map it to 500 `{ detail }`.

- [ ] Tests first (`tests/monitoring-delete.test.ts`): `parseIds` accepts 1 uuid, rejects `[]`, 201 ids, non-uuid, non-object; `deleteTraces` calls `rpc("monitoring_delete_traces", { p_ids })` and maps the jsonb; `reevaluate` resolving ⇒ `started`, rejecting ⇒ `failed` (logged, no throw), returning `undefined` ⇒ `skipped`, hanging ⇒ `failed` after the cap (use `reevaluateCapMs: 20`); RPC error ⇒ throws; no client ⇒ `undefined`; `deleteAlertEvents` maps the int. Auth test: `isProtectedPath("/api/monitoring/alerts/events/abc")` true. Run ⇒ RED.
- [ ] Implement `delete.ts`, the four DELETE handlers (all: `dashboardEnabled()` 404; parse body or `[id]` param; 400 `{ detail: "invalid ids" }`; 503 when the module returns `undefined`; 500 `{ detail }` on throw; `Response.json(result)`), `isProtectedPath`, matcher. ⇒ GREEN, typecheck, full suite.
- [ ] Manual: with cookie, `curl -X DELETE …/api/monitoring/traces -d '{"ids":["not-a-uuid"]}'` ⇒ 400; without cookie ⇒ 401. Do not delete real data here.
- [ ] Commit: `monitoring: DELETE routes for traces and alert events with background re-evaluation`.

---

### Task 3: Shared delete UI (dialog, bar, hook, selection helper)

**Files:** Create `components/monitoring/selection.ts` (pure), `components/monitoring/ConfirmDialog.tsx`, `components/monitoring/DeleteBar.tsx`, `components/monitoring/useDeleteFlow.ts`; test `tests/monitoring-selection.test.ts`; modify `components/monitoring/HeaderNav.tsx` (re-fetch status on `pathname` change and on `window` event `navio:refresh`).

**Interfaces:**
```ts
// selection.ts
export function toggle(set: ReadonlySet<string>, id: string): Set<string>;
export function selectAll(set: ReadonlySet<string>, ids: string[]): Set<string>;   // adds all
export function clearAll(): Set<string>;
export function allSelected(set: ReadonlySet<string>, ids: string[]): boolean;
export function deleteBody(kind: "trace" | "alert", n: number): string;   // the German confirm text from spec §5
// useDeleteFlow.ts (client)
export function useDeleteFlow(opts: { endpoint: string; kind: "trace" | "alert"; onDone?: () => void }): { busy: boolean; error: string | null; detail: string | null; confirm: (ids: string[]) => void; dialog: ReactNode }
```
`confirm(ids)` opens the dialog; on "Endgültig löschen" it `fetch(endpoint, { method: "DELETE", body: { ids } })`, on ok: `router.refresh()`, `window.dispatchEvent(new Event("navio:refresh"))`, `onDone?.()`; on failure sets `error = "Löschen fehlgeschlagen – bitte erneut versuchen."` and `detail` = raw text, keeps the selection. `ConfirmDialog` = native `<dialog>` (`showModal`), title, body, "Abbrechen" (`BTN_SECONDARY`) / "Endgültig löschen" (red: `inline-flex h-10 items-center rounded-full bg-(--red) px-4 font-display text-sm font-semibold text-white`), Escape closes. `DeleteBar` = sticky bottom bar (`fixed inset-x-4 bottom-4 z-30 mx-auto max-w-3xl` using `CARD` + `soft-shadow`), "N ausgewählt" · "Auswahl aufheben" (`BTN_GHOST`) · "Löschen" (red).

- [ ] Tests first for `selection.ts` (toggle add/remove, selectAll idempotent, allSelected on empty ids = false, `deleteBody("trace", 1)` = "1 Ausführung samt Schritten, Fehlern und Bewertungen wird endgültig gelöscht. Leere Sitzungen werden ebenfalls entfernt.", `deleteBody("trace", 3)` uses "3 Ausführungen … werden", `deleteBody("alert", 2)` = "2 Meldungen werden endgültig gelöscht. Der aktuelle Alarmstatus bleibt unverändert."). RED → implement → GREEN.
- [ ] Implement the three client files and the HeaderNav change (`useEffect` deps `[pathname]` + an event listener for `navio:refresh`, cleaned up).
- [ ] Typecheck + full suite. Commit: `monitoring: shared confirm dialog, selection bar and delete flow`.

---

### Task 4: Traces — list, detail, session page

**Files:** Modify `components/monitoring/TraceList.tsx` (becomes `"use client"`; props unchanged except `params: string` — the overview page passes `sp.toString()`, mirroring the AlertFeed fix); modify `app/monitoring/page.tsx` (pass the string); create `components/monitoring/DeleteTraceButton.tsx`; modify `app/monitoring/traces/[id]/page.tsx` (button in `actions`); modify `app/monitoring/sessions/[id]/page.tsx` (per-turn trash via `DeleteTraceButton` `size="sm"`).

- [ ] `TraceList`: checkbox column first (`<input type="checkbox">` with `aria-label`), header checkbox = all shown rows, trash icon column last (`ICON_BTN`, `Trash2`, `aria-label="Ausführung löschen"`, `relative z-10` so it sits above the stretched row link), `DeleteBar` when selection non-empty, `useDeleteFlow({ endpoint: "/api/monitoring/traces", kind: "trace", onDone: clear selection })`. Keep the table markup and min-width; the empty state and "Load older executions" unchanged. Selection resets when `items` change (ids no longer present are dropped).
- [ ] `DeleteTraceButton({ id, size, afterDelete: "overview" | "refresh" })`: on the detail page `afterDelete="overview"` ⇒ `router.push("/monitoring")` then `router.refresh()`; on the session page `"refresh"`.
- [ ] Browser: log in; select two throwaway traces (create them by asking the widget two FAQ questions on `/widget`, NOT the partner screen) → delete → confirm dialog text → tiles/bars/table update without reload; open a trace → Löschen → back on overview; session page trash works; 375 px has no horizontal page scroll. Screenshots to `%TEMP%\alerts-screens\delete-*.png`.
- [ ] Typecheck + suite. Commit: `monitoring: delete traces from the list, the trace page and the session view`.

---

### Task 5: Alerts feed delete

**Files:** Modify `components/monitoring/AlertFeed.tsx` (checkbox + per-row trash + `DeleteBar` + `useDeleteFlow({ endpoint: "/api/monitoring/alerts/events", kind: "alert" })`).

- [ ] Add the controls without changing the row's existing layout (checkbox at the row's left edge before the pill; trash next to "Bestätigen"). Rows removed by a delete disappear on `router.refresh()`; the client-side "Mehr laden" pages are dropped on refresh (acceptable; the first page re-renders).
- [ ] Browser: delete one old `test` event and one digest ⇒ rows gone, "N angezeigt" counter updated, red dot/banner unchanged (state untouched). Do NOT click "Jetzt auswerten"/"Testalarm senden".
- [ ] Commit: `monitoring: delete alert events from the feed`.

---

### Task 6: Live check + docs

**Files:** Modify `scripts/monitoring-verify.ts` (new "delete" section per spec §6, throwaway session tagged `metadata.verify=true`, cleaned up in `finally`); modify `docs/MONITORING.md` §4 (one paragraph on deleting + what cascades + the automatic re-evaluation) and §6 (the API routes); CLAUDE.md §17 one bullet (gitignored, not committed).

- [ ] Run `npm run monitoring:verify` with the widget + V3 running if available; if V3 (`:3008`) is down, run only the delete section (`--only delete` flag) and say so.
- [ ] Commit: `monitoring: verify script covers delete cascade; docs`.

## Self-review
Spec §3 → T1; §4 → T2; §5 → T3–T5 (dialog/bar/hook, list, detail, session, feed, HeaderNav); §6 → T2/T3 unit, T6 live, T4/T5 browser. Names: `deleteTraces`/`deleteAlertEvents`/`parseIds` (T2) used by routes; `useDeleteFlow`/`DeleteBar`/`ConfirmDialog`/`selection.ts` (T3) used by T4/T5; `DeleteTraceButton` (T4) used on two pages.
