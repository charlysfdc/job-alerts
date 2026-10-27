-- AiA Job Alerts, phase 0: who may sign in, and who sees what.
-- Run once in the Supabase SQL editor of the job-alerts project.
-- No personal data lives in this file (the repo is public): people and admins are added
-- from supabase/seed.private.sql, which stays on Charly's Mac (gitignored).

-- admins: Charly (and anyone helping run it) -----------------------------

create table admins (
  email text primary key,
  note text,
  created_at timestamptz not null default now()
);

-- people: the job seekers -------------------------------------------------

create table people (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null unique,             -- the Google account they sign in with
  email_confirmed boolean not null default false,
  home_base text,
  drive_folder_id text,                   -- their folder in Charly's Drive
  schedule text not null default 'daily' check (schedule in ('daily', 'mon_wed_fri', 'weekly', 'paused')),
  run_at time,                            -- Central time
  user_id uuid unique references auth.users(id) on delete set null,
  last_sign_in_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger people_touch before update on people
  for each row execute function touch_updated_at();

-- helpers -----------------------------------------------------------------

create or replace function jwt_email() returns text
language sql stable as $$
  select lower(coalesce(auth.jwt() ->> 'email', ''));
$$;

create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from admins where lower(email) = jwt_email());
$$;

create or replace function my_person_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from people where lower(email) = jwt_email();
$$;

-- Who am I? The page asks this once after sign-in to pick the admin or the job seeker view.
create or replace function me() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'role', case when is_admin() then 'admin' when my_person_id() is not null then 'seeker' else 'none' end,
    'email', jwt_email(),
    'person', (select json_build_object('id', p.id, 'name', p.name) from people p where p.id = my_person_id())
  );
$$;

-- Only listed Google accounts can create a login at all -------------------

create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from admins where lower(email) = lower(coalesce(new.email, '')))
     and not exists (select 1 from people where lower(email) = lower(coalesce(new.email, ''))) then
    raise exception 'This Google account is not on the AiA Job Alerts list';
  end if;
  update people set user_id = new.id where lower(email) = lower(new.email);
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- Remember when each person last signed in (Charly's overview shows it).
create or replace function handle_user_sign_in() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.last_sign_in_at is distinct from old.last_sign_in_at then
    update people set last_sign_in_at = new.last_sign_in_at, user_id = new.id
      where lower(email) = lower(new.email);
  end if;
  return new;
end $$;

create trigger on_auth_user_signed_in
  after update of last_sign_in_at on auth.users
  for each row execute function handle_user_sign_in();

-- Row-level security ------------------------------------------------------
-- Admins see and change everything. A job seeker sees only their own row and changes nothing here.

alter table admins enable row level security;
alter table people enable row level security;

create policy "admins read admins" on admins for select to authenticated using (is_admin());

create policy "admins all people" on people for all to authenticated using (is_admin()) with check (is_admin());
create policy "seeker reads own"  on people for select to authenticated using (lower(email) = jwt_email());

revoke all on admins, people from anon;
grant execute on function me() to authenticated;
revoke execute on function me() from anon;
