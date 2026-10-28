-- clean_fact: when the clause after a ";" is dropped, end the kept clause with "." instead of ";".
create or replace function clean_fact(t text) returns text
language sql immutable as $$
  with parts as (
    select s, n,
           s !~* '(TO CONFIRM|^always |include only if|leave out unless|looking it up|charly)' as keep
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
