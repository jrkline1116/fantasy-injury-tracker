-- Fantasy Injury Tracker: run the backend every minute.
-- Run this AFTER the edge functions are deployed (README step 5).
-- Replace the two placeholder values first. Run it once.

select vault.create_secret('https://YOUR-PROJECT-REF.supabase.co', 'fit_project_url');
select vault.create_secret('PASTE-THE-SAME-CRON_SECRET-YOU-SET-IN-STEP-4', 'fit_cron_secret');

select cron.schedule(
  'fit-tick',
  '* * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'fit_project_url') || '/functions/v1/tick',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'fit_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);

-- Useful later:
--   See recent runs:   select * from cron.job_run_details order by start_time desc limit 20;
--   See responses:     select id, status_code, left(content::text, 300) from net._http_response order by id desc limit 20;
--   Pause the backend: select cron.unschedule('fit-tick');
