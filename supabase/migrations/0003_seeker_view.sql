-- AiA Job Alerts: the job seeker's own view, built to work with or without a coach.
-- Today every person has a coach (Charly) who reviews what they send. Later, with self sign-up, a person with no
-- coach answers questions straight into their own profile. Nothing here assumes Charly by name.

-- coaches -------------------------------------------------------------------

alter table admins add column display_name text;
alter table people add column coach_email text references admins(email) on delete set null;
-- existing people: coached by the first admin
update people set coach_email = (select email from admins order by created_at limit 1) where coach_email is null;

-- questions: asked of the person, in their words, optionally tied to a profile field -----

alter table to_confirm
  add column ask_person boolean not null default false,  -- shown to them in the app
  add column person_question text,                       -- the wording they see ("you", plain English)
  add column field text,                                 -- profile column the answer fills, if any
  add column answer_kind text not null default 'text' check (answer_kind in ('text', 'yesno', 'number', 'choice')),
  add column choices text[] not null default '{}',       -- for 'choice': the allowed values of the field
  add column answered_at timestamptz,
  add column answered_by text;                           -- 'person' or an admin email

alter table to_confirm add constraint to_confirm_field_ok check (
  field is null or field in ('work_authorization', 'remote', 'pay_floor_annual', 'pay_floor_hourly', 'max_commute_minutes')
);

-- Starter questions every new person gets (by admin or, later, by self sign-up).
create table question_templates (
  id uuid primary key default gen_random_uuid(),
  position int not null,
  topic text not null,
  question text not null,           -- coach wording
  person_question text not null,    -- their wording
  field text,
  answer_kind text not null default 'text',
  choices text[] not null default '{}',
  active boolean not null default true
);
alter table question_templates enable row level security;
create policy "admins all question_templates" on question_templates for all to authenticated using (is_admin()) with check (is_admin());

insert into question_templates (position, topic, question, person_question, field, answer_kind, choices) values
 (1, 'Work authorisation', 'US citizen, green card holder, on a work permit (EAD), or needs sponsorship?',
  'Which of these describes your right to work in the US?', 'work_authorization', 'choice',
  array['citizen', 'green_card', 'work_permit', 'needs_sponsorship']),
 (2, 'Pay floor', 'What is their minimum salary or hourly rate?',
  'What''s the lowest pay you''d accept? An hourly rate or a yearly salary is fine.', null, 'text', '{}'),
 (3, 'Commute and remote', 'How far will they drive each day, and do they want remote work?',
  'How long a daily drive is OK for you, and would you like remote work?', null, 'text', '{}');

create or replace function handle_new_person() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (person_id) values (new.id) on conflict do nothing;
  insert into to_confirm (person_id, topic, question, person_question, field, answer_kind, choices, ask_person)
    select new.id, topic, question, person_question, field, answer_kind, choices, true
    from question_templates where active order by position;
  return new;
end $$;

-- messages from the person ("Something wrong? Tell …") ---------------------

create table requests (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people(id) on delete cascade,
  section text not null,            -- which part of their profile it is about
  message text not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text
);
create index requests_open on requests (person_id) where resolved_at is null;
alter table requests enable row level security;
create policy "admins all requests" on requests for all to authenticated using (is_admin()) with check (is_admin());

alter table applications add column added_by text not null default 'admin';   -- 'admin' or 'person'

revoke all on question_templates, requests from anon;

-- Facts as the person sees them: notes meant for the coach removed. ---------
-- Drops bracketed dates and "(confirmed …)" asides, and any sentence that is an instruction or an open question.
create or replace function clean_fact(t text) returns text
language sql immutable as $$
  select nullif(trim(string_agg(s, ' ')), '')
  from regexp_split_to_table(
    regexp_replace(t,
      '\s*\((?:confirmed[^()]*|[^()]*\m(?:January|February|March|April|May|June|July|August|September|October|November|December)\M[^()]*|[^()]*TO CONFIRM[^()]*)\)',
      '', 'gi'),
    '(?<=[.;])\s+') as s
  where s !~* '(TO CONFIRM|^always |include only if|leave out unless|looking it up|charly)';
$$;

-- The person's whole view in one call. Only what they should see; never the coach's notes. --
create or replace function person_view(p_id uuid) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'person', json_build_object('id', p.id, 'name', p.name, 'first_name', split_part(p.name, ' ', 1), 'home_base', p.home_base),
    'coach', (select json_build_object('name', coalesce(a.display_name, split_part(a.email, '@', 1))) from admins a where a.email = p.coach_email),
    'profile', json_build_object(
      'remote', pr.remote,
      'max_commute_minutes', pr.max_commute_minutes,
      'in_range_places', pr.in_range_places,
      'employment_types', pr.employment_types,
      'pay_floor_annual', pr.pay_floor_annual,
      'pay_floor_hourly', pr.pay_floor_hourly,
      'headline', pr.headline,
      'facts', coalesce((select json_agg(c) from (select clean_fact(f) c from unnest(pr.facts) with ordinality u(f, n) order by n) x where c is not null), '[]'::json),
      'families', coalesce((select json_agg(json_build_object('name', f.name, 'titles', f.search_titles[1:6]) order by f.position)
                            from job_families f where f.person_id = p.id and f.active), '[]'::json)
    ),
    'questions', coalesce((select json_agg(json_build_object(
        'id', t.id, 'topic', t.topic, 'question', t.person_question, 'kind', t.answer_kind, 'choices', t.choices,
        'answer', t.answer, 'answered_at', t.answered_at, 'done', t.resolved_at is not null) order by t.created_at)
      from to_confirm t where t.person_id = p.id and t.ask_person and t.person_question is not null), '[]'::json),
    'applications', coalesce((select json_agg(json_build_object(
        'id', a.id, 'employer', a.employer, 'title', a.title, 'status', a.status, 'added_by', a.added_by) order by a.created_at desc)
      from applications a where a.person_id = p.id), '[]'::json),
    'requests', coalesce((select json_agg(json_build_object(
        'id', r.id, 'section', r.section, 'message', r.message, 'created_at', r.created_at, 'done', r.resolved_at is not null) order by r.created_at desc)
      from requests r where r.person_id = p.id), '[]'::json)
  )
  from people p left join profiles pr on pr.person_id = p.id
  where p.id = p_id and (is_admin() or p.id = my_person_id());
$$;

create or replace function my_view() returns json
language sql stable security definer set search_path = public as $$
  select person_view(my_person_id());
$$;

-- What the person can do -----------------------------------------------------

-- Answer a question. With a coach, the answer waits for review; without one, a field-linked answer is saved straight away.
create or replace function answer_question(q_id uuid, answer_text text) returns void
language plpgsql security definer set search_path = public as $$
declare
  q to_confirm;
  coached boolean;
begin
  select * into q from to_confirm where id = q_id and person_id = my_person_id() and ask_person;
  if not found then raise exception 'Question not found'; end if;
  if coalesce(trim(answer_text), '') = '' then raise exception 'Write an answer first'; end if;
  update to_confirm set answer = left(trim(answer_text), 2000), answered_at = now(), answered_by = 'person', resolved_at = null
    where id = q_id;
  select coach_email is not null into coached from people where id = q.person_id;
  if not coached and q.field is not null then
    perform apply_answer(q_id);
  end if;
end $$;

-- Copy an answer into the profile field it belongs to, and close the question. Coaches call this from the app.
create or replace function apply_answer(q_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  q to_confirm;
  v text;
begin
  select * into q from to_confirm where id = q_id;
  if not found then raise exception 'Question not found'; end if;
  if not (is_admin() or (q.person_id = my_person_id() and (select coach_email is null from people where id = q.person_id))) then
    raise exception 'Not allowed';
  end if;
  v := trim(q.answer);
  if q.field is not null and v is not null then
    if q.field in ('work_authorization', 'remote') then
      if not v = any (q.choices) then raise exception 'Answer is not one of the choices'; end if;
      execute format('update profiles set %I = $1 where person_id = $2', q.field) using v, q.person_id;
    else
      execute format('update profiles set %I = $1 where person_id = $2', q.field)
        using nullif(regexp_replace(v, '[^0-9.]', '', 'g'), '')::numeric, q.person_id;
    end if;
  end if;
  update to_confirm set resolved_at = now() where id = q_id;
end $$;

create or replace function send_request(p_section text, p_message text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if my_person_id() is null then raise exception 'Not signed in as a job seeker'; end if;
  if coalesce(trim(p_message), '') = '' then raise exception 'Write a message first'; end if;
  insert into requests (person_id, section, message) values (my_person_id(), left(p_section, 80), left(trim(p_message), 2000));
end $$;

create or replace function add_my_application(p_employer text, p_title text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if my_person_id() is null then raise exception 'Not signed in as a job seeker'; end if;
  if coalesce(trim(p_employer), '') = '' or coalesce(trim(p_title), '') = '' then raise exception 'Add the employer and the job title'; end if;
  insert into applications (person_id, employer, title, status, added_by)
    values (my_person_id(), left(trim(p_employer), 200), left(trim(p_title), 200), 'submitted', 'person');
end $$;

revoke execute on function person_view(uuid), my_view(), answer_question(uuid, text), apply_answer(uuid),
  send_request(text, text), add_my_application(text, text) from anon, public;
grant execute on function person_view(uuid), my_view(), answer_question(uuid, text), apply_answer(uuid),
  send_request(text, text), add_my_application(text, text) to authenticated;
