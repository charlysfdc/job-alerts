-- AiA Job Alerts: the Charly Resume Method in the app.
-- 1. Two tracks: every job family is a bridge job ("asap") or the long-term career path.
-- 2. Method check on documents: things to remove, South African terms and UK spelling to change (documents.flags).
-- 3. Duties to accomplishments: suggested rewrites with metric gaps written as [[phrase with __]]; each gap becomes a
--    question, and the answer drops into the fact ("not sure" removes the phrase).
-- 4. A profile can be checked without a document (suggestions.document_id is then empty).

alter table job_families add column track text not null default 'long_term' check (track in ('asap', 'long_term'));

alter table documents add column flags jsonb not null default '[]'::jsonb;   -- [{kind, found, fix}]

alter table suggestions alter column document_id drop not null;
alter table suggestions drop constraint suggestions_kind_check;
alter table suggestions add constraint suggestions_kind_check
  check (kind in ('fact_new', 'fact_change', 'fact_rewrite', 'headline', 'family'));
alter table suggestions add column metrics jsonb not null default '[]'::jsonb;   -- [{placeholder, question}]

alter table to_confirm add column placeholder text;   -- for field 'fact_metric': the [[…]] phrase in the facts
alter table to_confirm drop constraint to_confirm_field_ok;
alter table to_confirm add constraint to_confirm_field_ok check (
  field is null or field in ('work_authorization', 'remote', 'pay_floor_annual', 'pay_floor_hourly', 'max_commute_minutes', 'fact_metric')
);

-- "not sure" (or similar) means: leave that phrase out.
create or replace function is_unsure(a text) returns boolean
language sql immutable as $$
  select coalesce(trim(a), '') = '' or a ~* '^\s*(not sure|unsure|don.?t know|no idea|skip|n/?a|none|-)\s*\.?\s*$';
$$;

-- Fill one [[… __ …]] gap in the person's facts with an answer, or remove the phrase.
create or replace function fill_metric(p_person uuid, p_placeholder text, p_answer text) returns void
language plpgsql security definer set search_path = public as $$
declare
  filled text;
begin
  if is_unsure(p_answer) then
    filled := '';
  else
    filled := replace(substr(p_placeholder, 3, length(p_placeholder) - 4), '__', trim(p_answer));
  end if;
  -- only the fact holding the gap is touched; spaces left by a removed phrase are tidied in that fact alone
  update profiles set facts = array(
    select case when position(p_placeholder in f) > 0
                then regexp_replace(regexp_replace(replace(f, p_placeholder, filled), '\s{2,}', ' ', 'g'), '\s+([,.;:])', '\1', 'g')
                else f end
    from unnest(facts) with ordinality u(f, n) order by n
  ) where person_id = p_person;
end $$;

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
  if q.field = 'fact_metric' then
    perform fill_metric(q.person_id, q.placeholder, v);
  elsif q.field is not null and v is not null then
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

-- Accepting a suggestion also asks the questions for its metric gaps.
create or replace function decide_suggestion(s_id uuid, accept boolean) returns void
language plpgsql security definer set search_path = public as $$
declare
  s suggestions;
  cur text;
  pos int;
  m jsonb;
begin
  select * into s from suggestions where id = s_id;
  if not found then raise exception 'Suggestion not found'; end if;
  if not can_decide_for(s.person_id) then raise exception 'Not allowed'; end if;
  if s.status <> 'pending' then raise exception 'Already decided'; end if;

  if accept then
    if s.kind = 'fact_new' then
      update profiles set facts = facts || s.proposed_text, updated_by = jwt_email() where person_id = s.person_id;
    elsif s.kind in ('fact_change', 'fact_rewrite') then
      select facts[s.fact_index] into cur from profiles where person_id = s.person_id;
      if cur is distinct from s.current_text then
        raise exception 'That part of the profile changed since this was suggested. Skip it and check again.';
      end if;
      update profiles set facts[s.fact_index] = s.proposed_text, updated_by = jwt_email() where person_id = s.person_id;
    elsif s.kind = 'headline' then
      update profiles set headline = s.proposed_text, updated_by = jwt_email() where person_id = s.person_id;
    elsif s.kind = 'family' then
      select coalesce(max(position), 0) + 1 into pos from job_families where person_id = s.person_id;
      insert into job_families (person_id, position, letter, name, why, search_titles, track)
        values (s.person_id, pos, chr(64 + pos), s.family ->> 'name', s.family ->> 'why',
                coalesce(array(select jsonb_array_elements_text(s.family -> 'search_titles')), '{}'),
                case when s.family ->> 'track' = 'asap' then 'asap' else 'long_term' end);
    end if;

    for m in select * from jsonb_array_elements(s.metrics) loop
      if position((m ->> 'placeholder') in s.proposed_text) > 0 then
        insert into to_confirm (person_id, topic, question, person_question, field, placeholder, ask_person)
          values (s.person_id, 'A number for your resume', m ->> 'question', m ->> 'question', 'fact_metric', m ->> 'placeholder', true);
      end if;
    end loop;
  end if;

  update suggestions set status = case when accept then 'accepted' else 'skipped' end, decided_by = coalesce(nullif(jwt_email(), ''), 'person'), decided_at = now()
    where id = s_id;
end $$;

revoke execute on function fill_metric(uuid, text, text) from anon, public, authenticated;

-- The person's view: tracks on families, document flags, metric questions, rewrite suggestions with their gaps.
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
      from suggestions s where s.person_id = p.id and s.status = 'pending'), '[]'::json)
  )
  from people p left join profiles pr on pr.person_id = p.id
  where p.id = p_id and (is_admin() or p.id = my_person_id());
$$;
