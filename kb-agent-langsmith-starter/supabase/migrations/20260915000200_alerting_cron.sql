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
