-- AiA Job Alerts: upload a resume or document; Claude reads it and suggests profile updates.
-- Files live in the private Storage bucket "documents" under <person id>/. Nothing changes the profile until a
-- suggestion is accepted: by the coach, or by the person themselves when they have no coach.

-- storage ------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('documents', 'documents', false, 10485760,
        array['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain'])
on conflict (id) do nothing;

create policy "people read own documents" on storage.objects for select to authenticated
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = my_person_id()::text);
create policy "people upload own documents" on storage.objects for insert to authenticated
  with check (bucket_id = 'documents' and (storage.foldername(name))[1] = my_person_id()::text);
create policy "admins all documents" on storage.objects for all to authenticated
  using (bucket_id = 'documents' and is_admin()) with check (bucket_id = 'documents' and is_admin());

-- documents and what Claude found in them -----------------------------------------

create table documents (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people(id) on delete cascade,
  path text not null unique,                -- <person id>/<uuid>-<file name> in the documents bucket
  filename text not null,
  mime text not null,
  size_bytes int,
  uploaded_by text not null,                -- 'person' or an admin email
  status text not null default 'uploaded' check (status in ('uploaded', 'reading', 'ready', 'failed')),
  kind text,                                -- resume, linkedin, certificate, other (Claude's guess)
  summary text,                             -- one line on what it is and what was found
  error text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);
create index documents_person on documents (person_id, created_at desc);

create table suggestions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  person_id uuid not null references people(id) on delete cascade,
  kind text not null check (kind in ('fact_new', 'fact_change', 'headline', 'family')),
  fact_index int,                           -- 1-based position in profiles.facts, for fact_change
  current_text text,                        -- what the profile says now (fact_change, headline)
  proposed_text text,                       -- the new or changed fact / headline
  family jsonb,                             -- {name, why, search_titles} for kind 'family'
  reason text,                              -- why, in plain words
  status text not null default 'pending' check (status in ('pending', 'accepted', 'skipped')),
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index suggestions_pending on suggestions (person_id) where status = 'pending';

alter table documents enable row level security;
alter table suggestions enable row level security;
create policy "admins all documents rows" on documents for all to authenticated using (is_admin()) with check (is_admin());
create policy "admins all suggestions" on suggestions for all to authenticated using (is_admin()) with check (is_admin());
revoke all on documents, suggestions from anon;

-- who may accept a suggestion: an admin, or the person when nobody coaches them ---------

create or replace function can_decide_for(p_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select is_admin() or (p_id = my_person_id() and (select coach_email is null from people where id = p_id));
$$;

-- Record an uploaded file (the page uploads to Storage first, then calls this).
create or replace function register_document(p_person uuid, p_path text, p_filename text, p_mime text, p_size int) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  d uuid;
begin
  if not (is_admin() or p_person = my_person_id()) then raise exception 'Not allowed'; end if;
  if left(p_path, 37) <> p_person::text || '/' then raise exception 'The file is in the wrong folder'; end if;
  insert into documents (person_id, path, filename, mime, size_bytes, uploaded_by)
    values (p_person, p_path, left(p_filename, 200), p_mime, p_size, case when is_admin() then jwt_email() else 'person' end)
    returning id into d;
  return d;
end $$;

-- Accept or skip one suggestion. Accepting writes it into the profile.
create or replace function decide_suggestion(s_id uuid, accept boolean) returns void
language plpgsql security definer set search_path = public as $$
declare
  s suggestions;
  cur text;
  pos int;
begin
  select * into s from suggestions where id = s_id;
  if not found then raise exception 'Suggestion not found'; end if;
  if not can_decide_for(s.person_id) then raise exception 'Not allowed'; end if;
  if s.status <> 'pending' then raise exception 'Already decided'; end if;

  if accept then
    if s.kind = 'fact_new' then
      update profiles set facts = facts || s.proposed_text, updated_by = jwt_email() where person_id = s.person_id;
    elsif s.kind = 'fact_change' then
      select facts[s.fact_index] into cur from profiles where person_id = s.person_id;
      if cur is distinct from s.current_text then
        raise exception 'That part of the profile changed since this was suggested. Skip it and upload again.';
      end if;
      update profiles set facts[s.fact_index] = s.proposed_text, updated_by = jwt_email() where person_id = s.person_id;
    elsif s.kind = 'headline' then
      update profiles set headline = s.proposed_text, updated_by = jwt_email() where person_id = s.person_id;
    elsif s.kind = 'family' then
      select coalesce(max(position), 0) + 1 into pos from job_families where person_id = s.person_id;
      insert into job_families (person_id, position, letter, name, why, search_titles)
        values (s.person_id, pos, chr(64 + pos), s.family ->> 'name', s.family ->> 'why',
                coalesce(array(select jsonb_array_elements_text(s.family -> 'search_titles')), '{}'));
    end if;
  end if;

  update suggestions set status = case when accept then 'accepted' else 'skipped' end, decided_by = coalesce(jwt_email(), 'person'), decided_at = now()
    where id = s_id;
end $$;

revoke execute on function register_document(uuid, text, text, text, int), decide_suggestion(uuid, boolean), can_decide_for(uuid) from anon, public;
grant execute on function register_document(uuid, text, text, text, int), decide_suggestion(uuid, boolean), can_decide_for(uuid) to authenticated;

-- the person's view gains their documents and the pending suggestions ---------------

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
      from requests r where r.person_id = p.id), '[]'::json),
    'documents', coalesce((select json_agg(json_build_object(
        'id', d.id, 'path', d.path, 'filename', d.filename, 'status', d.status, 'kind', d.kind, 'summary', d.summary,
        'error', d.error, 'created_at', d.created_at) order by d.created_at desc)
      from documents d where d.person_id = p.id), '[]'::json),
    'suggestions', coalesce((select json_agg(json_build_object(
        'id', s.id, 'document_id', s.document_id, 'kind', s.kind, 'current_text', s.current_text, 'proposed_text', s.proposed_text,
        'family', s.family, 'reason', s.reason) order by s.created_at)
      from suggestions s where s.person_id = p.id and s.status = 'pending'), '[]'::json)
  )
  from people p left join profiles pr on pr.person_id = p.id
  where p.id = p_id and (is_admin() or p.id = my_person_id());
$$;
