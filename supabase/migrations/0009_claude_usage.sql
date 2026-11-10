-- 0009: record what Claude used on each daily search, so the cost per person can be measured.
-- The daily-search function writes these after each run. Runs before this migration stay null.
-- Run this in the Supabase SQL editor. The function works whether or not it has been run yet.

alter table runs
  add column if not exists claude_model text,
  add column if not exists claude_input_tokens int,
  add column if not exists claude_output_tokens int,
  add column if not exists claude_cache_read_tokens int,
  add column if not exists claude_cache_write_tokens int;

-- Cost per person per month, at the Claude Opus 5.5 list price (per million tokens:
-- $4 input, $20 output, $0.20 cache read, $5 cache write). Change the rates here if the model or price changes.
create or replace view claude_cost_by_person
with (security_invoker = true) as
select
  p.name,
  date_trunc('month', r.started_at at time zone 'America/Chicago')::date as month,
  count(*) filter (where r.claude_input_tokens is not null) as runs_measured,
  sum(r.claude_input_tokens)  as input_tokens,
  sum(r.claude_output_tokens) as output_tokens,
  round((
      coalesce(sum(r.claude_input_tokens), 0)       * 4.00
    + coalesce(sum(r.claude_output_tokens), 0)      * 20.00
    + coalesce(sum(r.claude_cache_read_tokens), 0)  * 0.20
    + coalesce(sum(r.claude_cache_write_tokens), 0) * 5.00
  ) / 1e6, 2) as claude_cost_usd,
  round((
      coalesce(sum(r.claude_input_tokens), 0)       * 4.00
    + coalesce(sum(r.claude_output_tokens), 0)      * 20.00
    + coalesce(sum(r.claude_cache_read_tokens), 0)  * 0.20
    + coalesce(sum(r.claude_cache_write_tokens), 0) * 5.00
  ) / 1e6 / nullif(count(*) filter (where r.claude_input_tokens is not null), 0), 3) as cost_per_run_usd
from runs r
join people p on p.id = r.person_id
where r.status = 'done'
group by p.name, 2
order by 2 desc, p.name;
