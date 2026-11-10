-- 0008: the daily search (Phase 2).
-- runs   = one search for one person (scheduled or "Run now").
-- leads  = every posting a search has seen for a person, once (dedupe_key), including the ones
--          dropped by a rule (status 'filtered', so they are never judged twice).
-- Seekers read leads only through person_view and change them only through set_lead_status.
-- The edge function daily-search does the work; pg_cron calls it every 10 minutes and it
-- runs whoever is due (see next_due_person). Run this after the function is deployed.

create table runs (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people(id) on delete cascade,
  run_date date not null default (now() at time zone 'America/Chicago')::date,
  trigger text not null default 'schedule' check (trigger in ('schedule', 'manual')),
  status text not null default 'running' check (status in ('running', 'done', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  queries jsonb not null default '[]'::jsonb,   -- [{source, q, where, found, error?}]
  found int not null default 0,                  -- postings the sources returned
  fresh int not null default 0,                  -- not seen before for this person
  kept int not null default 0,                   -- passed the rules and Claude
  emailed_to text,
  error text
);
-- one scheduled run a day per person; "Run now" can run any time
create unique index runs_one_scheduled_a_day on runs (person_id, run_date) where trigger = 'schedule';
create index runs_person_started on runs (person_id, started_at desc);

create table leads (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people(id) on delete cascade,
  run_id uuid references runs(id) on delete set null,
  dedupe_key text not null,                      -- employer + title, normalised
  source text not null check (source in ('google_jobs', 'adzuna')),
  source_id text,
  title text not null,
  employer text not null,
  location text,
  remote boolean not null default false,
  url text,                                      -- best apply link (the employer's own when there is one)
  apply_links jsonb not null default '[]'::jsonb,
  posted_at date,
  pay_text text,
  employment_type text,
  description text,
  family text,                                   -- the job family it fits
  track text check (track in ('asap', 'long_term')),
  score int,
  fit text check (fit in ('strong', 'good', 'stretch')),
  why text,
  concerns text[] not null default '{}',
  status text not null default 'new' check (status in ('filtered', 'new', 'interested', 'not_for_me', 'applied')),
  filter_reason text,
  status_at timestamptz,
  emailed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (person_id, dedupe_key)
);
create index leads_person_status on leads (person_id, status, created_at desc);

-- Who gets the daily email. 'coach' sends it to the coach (a preview while the old scheduled
-- tasks still email the person); someone without a coach gets it themselves.
alter table people add column email_leads text not null default 'coach' check (email_leads in ('off', 'coach', 'person'));

alter table runs  enable row level security;
alter table leads enable row level security;
create policy "admins all runs"  on runs  for all to authenticated using (is_admin()) with check (is_admin());
create policy "admins all leads" on leads for all to authenticated using (is_admin()) with check (is_admin());

-- The next person whose search is due today (Central time) and has not run yet.
create or replace function next_due_person() returns uuid
language sql stable security definer set search_path = public as $$
  select p.id
  from people p join profiles pr on pr.person_id = p.id
  where p.schedule <> 'paused' and p.run_at is not null
    and (now() at time zone 'America/Chicago')::time >= p.run_at
    and case p.schedule
          when 'mon_wed_fri' then extract(isodow from now() at time zone 'America/Chicago') in (1, 3, 5)
          when 'weekly' then extract(isodow from now() at time zone 'America/Chicago') = 1
          else true end
    and not exists (select 1 from runs r where r.person_id = p.id and r.trigger = 'schedule'
                    and r.run_date = (now() at time zone 'America/Chicago')::date)
  order by p.run_at
  limit 1;
$$;
revoke execute on function next_due_person() from public, anon, authenticated;
grant execute on function next_due_person() to service_role;

-- Interested / Not for me / I applied / back to new. "I applied" also records the application.
create or replace function set_lead_status(l_id uuid, new_status text) returns void
language plpgsql security definer set search_path = public as $$
declare
  l leads;
begin
  if new_status not in ('new', 'interested', 'not_for_me', 'applied') then raise exception 'Unknown status'; end if;
  select * into l from leads where id = l_id;
  if l.id is null or not (is_admin() or l.person_id = my_person_id()) then raise exception 'Not allowed'; end if;
  update leads set status = new_status, status_at = now() where id = l_id;
  if new_status = 'applied' and not exists (
    select 1 from applications a where a.person_id = l.person_id
      and lower(a.employer) = lower(l.employer) and lower(a.title) = lower(l.title)) then
    insert into applications (person_id, employer, title, status, note, added_by)
    values (l.person_id, l.employer, l.title, 'submitted', l.url, case when is_admin() then 'admin' else 'person' end);
  end if;
end;
$$;

-- person_view: as in 0007, plus leads (new and interested, last 21 days, best first) and last_search.
create or replace function person_view(p_id uuid) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'person', json_build_object('id', p.id, 'name', p.name, 'first_name', split_part(p.name, ' ', 1), 'home_base', p.home_base),
    'coach', (select json_build_object('name', coalesce(a.display_name, split_part(a.email, '@', 1))) from admins a where a.email = p.coach_email),
    'can_decide', p.coach_email is null,
    'profile', json_build_object(
      'remote', pr.remote,
      'max_commute_minutes', pr.max_commute_minutes,
      'in_range_places', pr.in_range_places,
      'employment_types', pr.employment_types,
      'pay_floor_annual', pr.pay_floor_annual,
      'pay_floor_hourly', pr.pay_floor_hourly,
      'headline', pr.headline,
      'facts', coalesce((select json_agg(c) from (select clean_fact(f) c from unnest(pr.facts) with ordinality u(f, n) order by n) x where c is not null), '[]'::json),
      'families', coalesce((select json_agg(json_build_object('name', f.name, 'titles', f.search_titles[1:6], 'track', f.track) order by f.position)
                            from job_families f where f.person_id = p.id and f.active), '[]'::json)
    ),
    'questions', coalesce((select json_agg(json_build_object(
        'id', t.id, 'topic', t.topic, 'question', t.person_question, 'kind', t.answer_kind, 'choices', t.choices,
        'metric', t.field = 'fact_metric',
        'answer', t.answer, 'answered_at', t.answered_at, 'done', t.resolved_at is not null) order by t.created_at)
      from to_confirm t where t.person_id = p.id and t.ask_person and t.person_question is not null), '[]'::json),
    'applications', coalesce((select json_agg(json_build_object(
        'id', a.id, 'employer', a.employer, 'title', a.title, 'status', a.status, 'added_by', a.added_by) order by a.created_at desc)
      from applications a where a.person_id = p.id), '[]'::json),
    'requests', coalesce((select json_agg(json_build_object(
        'id', r.id, 'section', r.section, 'message', r.message, 'created_at', r.created_at, 'done', r.resolved_at is not null) order by r.created_at desc)
      from requests r where r.person_id = p.id), '[]'::json),
    'documents', coalesce((select json_agg(json_build_object(
        'id', d.id, 'path', d.path, 'filename', d.filename, 'status', d.status, 'kind', d.kind, 'summary', d.summary,
        'error', d.error, 'flags', d.flags, 'created_at', d.created_at) order by d.created_at desc)
      from documents d where d.person_id = p.id), '[]'::json),
    'suggestions', coalesce((select json_agg(json_build_object(
        'id', s.id, 'document_id', s.document_id, 'kind', s.kind, 'current_text', s.current_text, 'proposed_text', s.proposed_text,
        'family', s.family, 'reason', s.reason, 'metrics', s.metrics) order by s.created_at)
      from suggestions s where s.person_id = p.id and s.status = 'pending'), '[]'::json),
    'leads', coalesce((select json_agg(json_build_object(
        'id', l.id, 'title', l.title, 'employer', l.employer, 'location', l.location, 'remote', l.remote, 'url', l.url,
        'posted_at', l.posted_at, 'pay_text', l.pay_text, 'employment_type', l.employment_type, 'family', l.family,
        'track', l.track, 'score', l.score, 'fit', l.fit, 'why', l.why, 'concerns', l.concerns, 'status', l.status,
        'source', l.source, 'created_at', l.created_at)
        order by (l.status = 'interested') desc, l.score desc nulls last, l.created_at desc)
      from (select * from leads x where x.person_id = p.id and x.status in ('new', 'interested')
              and x.created_at > now() - interval '21 days'
            order by x.score desc nulls last limit 40) l), '[]'::json),
    'last_search', (select json_build_object('at', r.finished_at, 'kept', r.kept, 'status', r.status)
      from runs r where r.person_id = p.id and r.status <> 'running' order by r.started_at desc limit 1)
  )
  from people p left join profiles pr on pr.person_id = p.id
  where p.id = p_id and (is_admin() or p.id = my_person_id());
$$;

-- Every 10 minutes: ask the function to run whoever is due. The call carries no key on purpose:
-- the function only ever runs people who are due and have not run today, so a stray call is a no-op.
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;
select cron.schedule(
  'daily-search',
  '*/10 * * * *',
  $$ select net.http_post(
       url := 'https://zixdctuwmdnsayzjwmpd.supabase.co/functions/v1/daily-search',
       body := '{}'::jsonb,
       headers := '{"Content-Type": "application/json"}'::jsonb,
       timeout_milliseconds := 5000) $$
);
