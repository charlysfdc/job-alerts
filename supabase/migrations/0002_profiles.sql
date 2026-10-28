-- AiA Job Alerts, phase 1: job profiles (the source of truth for each person's search and documents).
-- Replaces the Master Job Profile Google Docs. Admin-only for now; job seekers get a read-only summary later.

-- profiles: one per person ---------------------------------------------------

create table profiles (
  person_id uuid primary key references people(id) on delete cascade,
  source_doc_id text,                       -- the Master Job Profile Doc it was imported from
  -- search rules
  work_authorization text not null default 'to_confirm'
    check (work_authorization in ('citizen', 'green_card', 'work_permit', 'authorized', 'needs_sponsorship', 'to_confirm')),
  work_authorization_note text,
  remote text not null default 'remote_ok'
    check (remote in ('remote_first', 'remote_ok', 'onsite_only')),
  max_commute_minutes int,
  commute_note text,
  in_range_places text[] not null default '{}',
  out_of_range_places text[] not null default '{}',
  relocation text,
  employment_types text[] not null default '{}',   -- full_time, part_time, contract, adjunct
  pay_floor_annual int,                            -- USD; null = not set
  pay_floor_hourly numeric(6, 2),
  pay_note text,
  hours_note text,
  education_note text,
  posting_window_days int not null default 14,
  exclusions text[] not null default '{}',
  other_rules text[] not null default '{}',        -- rules that are not a single field
  -- what they bring: the ONLY facts allowed on their documents
  headline text,
  facts text[] not null default '{}',
  never_claim text[] not null default '{}',        -- things the documents must never say
  -- where the daily search looks
  sources text[] not null default '{}',
  updated_at timestamptz not null default now(),
  updated_by text
);

create trigger profiles_touch before update on profiles
  for each row execute function touch_updated_at();

-- job families, in priority order -------------------------------------------

create table job_families (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people(id) on delete cascade,
  position int not null,
  letter text not null,                     -- A, B, C… as Charly and the person know them
  name text not null,
  active boolean not null default true,     -- false = kept on file but not searched
  why text,
  search_titles text[] not null default '{}',
  where_to_look text[] not null default '{}',
  gaps text[] not null default '{}',
  pay_seen text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index job_families_person on job_families (person_id, position);
create trigger job_families_touch before update on job_families
  for each row execute function touch_updated_at();

-- applications already made or under way (never suggested again) ------------

create table applications (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people(id) on delete cascade,
  employer text not null,
  title text not null,
  status text not null default 'in_progress'
    check (status in ('candidate', 'in_progress', 'submitted', 'interview', 'offer', 'closed')),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index applications_person on applications (person_id);
create trigger applications_touch before update on applications
  for each row execute function touch_updated_at();

-- TO CONFIRM: open questions about a person. Never used as search filters. -----

create table to_confirm (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people(id) on delete cascade,
  topic text not null,                      -- short label, e.g. "Pay floor"
  question text not null,
  answer text,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index to_confirm_open on to_confirm (person_id) where resolved_at is null;

-- Row-level security: admins only for now ------------------------------------

alter table profiles     enable row level security;
alter table job_families enable row level security;
alter table applications enable row level security;
alter table to_confirm   enable row level security;

create policy "admins all profiles"     on profiles     for all to authenticated using (is_admin()) with check (is_admin());
create policy "admins all job_families" on job_families for all to authenticated using (is_admin()) with check (is_admin());
create policy "admins all applications" on applications for all to authenticated using (is_admin()) with check (is_admin());
create policy "admins all to_confirm"   on to_confirm   for all to authenticated using (is_admin()) with check (is_admin());

revoke all on profiles, job_families, applications, to_confirm from anon;

-- A new person gets an empty profile straight away.
create or replace function handle_new_person() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (person_id) values (new.id) on conflict do nothing;
  return new;
end $$;

create trigger on_person_created after insert on people
  for each row execute function handle_new_person();

insert into profiles (person_id) select id from people on conflict do nothing;
