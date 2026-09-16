-- Navio alerting — pg_cron history housekeeping (docs/MONITORING-ALERTING.md § Supabase rules).
-- pg_cron never prunes cron.job_run_details (Supabase docs: "records are not cleaned up
-- automatically"). The build-time 5-minute test cadence added ~288 rows/day; the production
-- cadence adds 2/day plus this job's own row. Keep 30 days, prune weekly. pg_net's
-- net._http_response is NOT touched here — pg_net already expires it after pg_net.ttl (6 h).
select cron.schedule(
  'navio-cron-history-cleanup',
  '0 3 * * 0',  -- Sundays 03:00 UTC
  $$delete from cron.job_run_details where end_time < now() - interval '30 days'$$
);
