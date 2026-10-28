-- clean_fact: no longer drops sentences that mention "Charly" (a job seeker can be called Charly; coach notes are caught by the other patterns).
create or replace function clean_fact(t text) returns text
language sql immutable as $$
  with parts as (
    select s, n,
           s !~* '(TO CONFIRM|^always |include only if|leave out unless|looking it up)' as keep
    from regexp_split_to_table(
      regexp_replace(t,
        '\s*\((?:confirmed[^()]*|[^()]*\m(?:January|February|March|April|May|June|July|August|September|October|November|December)\M[^()]*|[^()]*TO CONFIRM[^()]*)\)',
        '', 'gi'),
      '(?<=[.;])\s+') with ordinality as x(s, n)
  ),
  marked as (
    select s, n, keep, lead(keep, 1, true) over (order by n) as next_keep from parts
  )
  select nullif(trim(string_agg(case when s ~ ';$' and not next_keep then regexp_replace(s, ';$', '.') else s end, ' ' order by n)), '')
  from marked where keep;
$$;
