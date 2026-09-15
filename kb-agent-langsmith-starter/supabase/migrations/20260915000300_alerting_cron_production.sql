-- Navio alerting — production schedule (spec §4 "Scheduling", docs/MONITORING-ALERTING.md
-- § "Supabase rules"). DO NOT APPLY until the go-live checklist there has been worked through:
-- ALERT_EVALUATE_SECRET set on navio-widget (production + preview) and matching the Vault
-- secret alert_evaluate_secret, the branch merged and redeployed so /api/monitoring/alerts/
-- evaluate actually exists, and net._http_response showing a 200 from the test job.
--
-- Production cadence (spec §4): 07:00 and 15:00 Europe/Berlin, written for CEST (UTC+2).
-- pg_cron has no timezone support, so this drifts one hour late in winter (CET, UTC+1) — not a
-- requirement per the spec ("two digests a day at roughly 7 and 15 o'clock"), but to keep it
-- accurate, shift both jobs at the DST boundary:
--   select cron.alter_job(job_id, schedule := '0 6 * * *')  from cron.job where jobname = 'navio-alerts-morning';
--   select cron.alter_job(job_id, schedule := '0 14 * * *') from cron.job where jobname = 'navio-alerts-afternoon';
-- and back to '0 5 * * *' / '0 13 * * *' at the spring boundary.
select cron.schedule('navio-alerts-morning',   '0 5 * * *',  $$select monitoring_call_evaluate('scheduled')$$);
select cron.schedule('navio-alerts-afternoon', '0 13 * * *', $$select monitoring_call_evaluate('scheduled')$$);
-- Remove the build-time test cadence.
select cron.unschedule('navio-alerts-test');
