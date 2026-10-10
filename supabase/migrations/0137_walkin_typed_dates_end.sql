-- ---------------------------------------------------------------------
-- 0137 - a walk-in whose date was TYPED ("6 and 7 october 2026") ends too
--
-- walkin_ends_at() (0106 / 0107) understood one format only, 2026-10-07.
-- A walk-in posted as "6 and 7 october 2026" (older forms, or typed) had
-- no end at all: it stayed in the Jobs list, Apply Now kept working days
-- after the drive, and the AI interview window never closed for it.
--
-- walkin_last_date() reads the LAST calendar date in the text:
--   2026-10-07 | 07/10/2026 | 7.10.2026 (day first, as written in India)
--   6 and 7 october 2026 | 6th & 7th Oct 2026 | October 6-7, 2026
--   30 september 2026 to 2 october 2026
-- and a typed walk-in ends at the end of that day (23:59 IST) - the time
-- fields of those postings are free text too ("end 4:00"), and an hour
-- guessed from them could close a drive at four in the morning.
--
-- A time that is not a time ("end 4:00") no longer breaks a 2026-10-07
-- date either: that day's end is used instead of an error.
--
-- Text with no year, or no date at all, still gives no end (as before):
-- nothing is closed on a guess.
--
-- Everything that already asks walkin_ends_at() follows: the Jobs list
-- (jobs_open), the save-time apply check (walkin_apply_check -> "closed"),
-- saved-job alerts and the walk-in reminders. The AI interview window
-- (0133) now asks it too, instead of its own ISO-only test.
-- ---------------------------------------------------------------------

create or replace function walkin_try_date(p_y int, p_m int, p_d int) returns date
language plpgsql immutable as $$
begin
  if p_y is null or p_m is null or p_d is null or p_y < 2000 or p_y > 2100 then return null; end if;
  return make_date(p_y, p_m, p_d);
exception when others then
  return null;                         -- 31 February and the like: not a date
end $$;

create or replace function walkin_month_no(p text) returns int
language sql immutable as $$
  select case left(lower(p), 3)
    when 'jan' then 1 when 'feb' then 2 when 'mar' then 3 when 'apr' then 4
    when 'may' then 5 when 'jun' then 6 when 'jul' then 7 when 'aug' then 8
    when 'sep' then 9 when 'oct' then 10 when 'nov' then 11 when 'dec' then 12 end
$$;

create or replace function walkin_last_date(p text) returns date
language plpgsql immutable as $$
declare
  s       text := lower(coalesce(p, ''));
  rx      constant text := '(january|february|march|april|may|june|july|august|september|october|november|december|sept|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)';
  daypat  constant text := '(?:^|[^0-9:])([0-9]{1,2})(?:st|nd|rd|th)?(?![0-9:])';
  best    date;
  d       date;
  g       text[];
  mons    text[];
  segs    text[];
  n       int;
  i       int;
  k       int;
  yr      int;
  dd      int;
  dayfirst boolean;
  part    text;
begin
  if btrim(s) = '' then return null; end if;

  /* 2026-10-07 */
  for g in select regexp_matches(s, '([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})', 'g') loop
    d := walkin_try_date(g[1]::int, g[2]::int, g[3]::int);
    if d is not null and (best is null or d > best) then best := d; end if;
  end loop;

  /* 07/10/2026, 7.10.2026, 07-10-2026 - day first */
  for g in select regexp_matches(s, '(?:^|[^0-9])([0-9]{1,2})[/.-]([0-9]{1,2})[/.-]([0-9]{4})', 'g') loop
    d := walkin_try_date(g[3]::int, g[2]::int, g[1]::int);
    if d is not null and (best is null or d > best) then best := d; end if;
  end loop;

  /* month names: "6 and 7 october 2026", "october 6-7, 2026" */
  select array_agg(x[1]) into mons from regexp_matches(s, '(?<![a-z])' || rx || '(?![a-z])', 'g') as x;
  n := coalesce(array_length(mons, 1), 0);
  if n > 0 then
    segs := regexp_split_to_array(s, '(?<![a-z])' || rx || '(?![a-z])');
    /* the style is decided once, by the first month: a day written before it means day-first */
    dayfirst := regexp_replace(segs[1], '[0-9]{4}', '', 'g') ~ daypat;
    for i in 1..n loop
      /* the year: the first four-digit number after this month */
      yr := null;
      for k in (i + 1)..array_length(segs, 1) loop
        g := regexp_match(segs[k], '([0-9]{4})');
        if g is not null then yr := g[1]::int; exit; end if;
      end loop;
      if yr is null then continue; end if;
      /* the days: before the month (day-first), or after it up to the year (month-first) */
      part := case when dayfirst then segs[i]
                   else split_part(regexp_replace(segs[i + 1], '([0-9]{4})', '|\1'), '|', 1) end;
      part := regexp_replace(part, '[0-9]{4}', ' ', 'g');
      for g in select regexp_matches(part, daypat, 'g') loop
        dd := g[1]::int;
        d := walkin_try_date(yr, walkin_month_no(mons[i]), dd);
        if d is not null and (best is null or d > best) then best := d; end if;
      end loop;
    end loop;
  end if;

  return best;
end $$;

comment on function walkin_last_date(text) is
  'The last calendar date in a walk-in date as typed (ISO, dd/mm/yyyy, or with a month name). NULL when there is none or no year (0137).';

/* A time only when it IS one: "16:00", "4:00 pm", "9.30 am"; anything else is ignored. */
create or replace function walkin_clock(p text) returns text
language sql immutable as $$
  select case
    when btrim(coalesce(p, '')) ~* '^[0-9]{1,2}([:.][0-9]{2})?\s*(am|pm|a\.m\.|p\.m\.)?$'
     and btrim(coalesce(p, '')) ~ '[:.]|am|pm|a\.m|p\.m'
      then replace(replace(regexp_replace(lower(btrim(p)), '([0-9])\.([0-9])', '\1:\2'), 'a.m.', 'am'), 'p.m.', 'pm')
  end
$$;

create or replace function walkin_starts_at(p_date text, p_from text) returns timestamptz
language plpgsql immutable as $$
begin
  if p_date ~ '^\d{4}-\d{2}-\d{2}$' then
    begin
      return ((p_date || ' ' || coalesce(walkin_clock(p_from), '00:00'))::timestamp at time zone 'Asia/Kolkata');
    exception when others then
      return (p_date::date::timestamp at time zone 'Asia/Kolkata');
    end;
  end if;
  return null;                        -- unchanged: typed dates give no start time
end $$;

create or replace function walkin_ends_at(p_date text, p_to text) returns timestamptz
language plpgsql immutable as $$
declare d date;
begin
  if p_date ~ '^\d{4}-\d{2}-\d{2}$' then
    begin
      return ((p_date || ' ' || coalesce(walkin_clock(p_to), '23:59'))::timestamp at time zone 'Asia/Kolkata');
    exception when others then
      return ((p_date || ' 23:59')::timestamp at time zone 'Asia/Kolkata');
    end;
  end if;
  d := walkin_last_date(p_date);
  if d is null then return null; end if;
  return ((d::text || ' 23:59')::timestamp at time zone 'Asia/Kolkata');
end $$;

-- ---------------------------------------------------------------------
-- the AI interview window (0133) asks the same question
-- ---------------------------------------------------------------------
create or replace function ai_interview_window(p_application_id text)
returns table (open boolean, reason text, due_at timestamptz)
language sql stable security definer set search_path = public as $$
  with x as (
    select a.ai_interview_due_at as due, j.id as job_id, j.status, coalesce(j.archived, false) as archived,
           j.expires_at, j.posting_kind, j.walkin_date
      from applications a
      left join jobs j on j.id = a.job_id
     where a.id = p_application_id
  ), r as (
    select x.*,
           case
             when x.job_id is null                                   then 'job_closed'
             when x.status in ('closed', 'draft') or x.archived      then 'job_closed'
             when x.expires_at is not null and x.expires_at < now()  then 'job_expired'
             /* the walk-in DAY is over (its last day, IST) - typed dates included (0137) */
             when x.posting_kind = 'walkin'
                  and coalesce(walkin_ends_at(x.walkin_date, null) < now(), false)
                                                                     then 'walkin_over'
             when x.due is not null and x.due < now()                then 'due_passed'
             else null
           end as reason
      from x
  )
  select r.reason is null, r.reason, coalesce(r.due, r.expires_at) from r;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function walkin_try_date(int, int, int), walkin_month_no(text), walkin_last_date(text),
      walkin_clock(text), walkin_starts_at(text, text), walkin_ends_at(text, text) to app_api;
  end if;
end $$;
