-- ---------------------------------------------------------------------
-- 0094 — Resume score + improvement tips, worked out on the server
--
-- The score lived in the browser (resumeQualityScore, four parts and four
-- generic tips), was different on every device and was never stored, so
-- "your score went up" could not be said. It is now computed by
-- api/src/resume/score.js from the saved profile and the resume text, and
-- every result is a row here - that is the history.
--
--   candidate_resume_scores        one row per scoring: total, label, the
--                                  eight section scores, the tips, and the
--                                  optional AI tips (labelled as such)
--   candidate_resume_score_queue   candidates whose profile or resume
--                                  changed since they were last scored -
--                                  filled by triggers, emptied by the API
--
-- An UNREADABLE resume is a row with status 'unreadable' and NO total:
-- "We could not read your resume" is the honest answer, a 0 is not.
--
-- The score never affects eligibility or matching. Nothing outside the
-- score screens and the recruiter badge reads this table.
-- ---------------------------------------------------------------------

create table if not exists candidate_resume_scores (
  id              bigserial primary key,
  candidate_id    text not null references candidates(id) on delete cascade,
  -- which resume was scored: its storage path (or file name) and upload
  -- time, so "re-score only when a new resume is uploaded" is checkable
  resume_id       text,
  status          text not null default 'scored' check (status in ('scored','unreadable')),
  total_score     int check (total_score between 0 and 100),
  label           text check (label in ('Needs Work','Good','Strong','Excellent')),
  section_scores  jsonb not null default '{}'::jsonb,
  tips            jsonb not null default '[]'::jsonb,
  ai_tips         jsonb not null default '[]'::jsonb,
  engine          text not null default 'rules' check (engine in ('rules','ai')),
  -- md5 of everything the score was computed from; an identical input is
  -- not scored twice
  fingerprint     text,
  scored_at       timestamptz not null default now(),
  check ((status = 'scored' and total_score is not null and label is not null)
      or (status = 'unreadable' and total_score is null))
);

create index if not exists candidate_resume_scores_latest
  on candidate_resume_scores (candidate_id, scored_at desc, id desc);

create table if not exists candidate_resume_score_queue (
  candidate_id  text primary key references candidates(id) on delete cascade,
  queued_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- the latest score per candidate, for badges and the 70+ filter
-- ---------------------------------------------------------------------
create or replace view candidate_resume_score_latest_v
  with (security_invoker = true) as
  select distinct on (s.candidate_id)
         s.candidate_id, s.status, s.total_score, s.label, s.scored_at
    from candidate_resume_scores s
   order by s.candidate_id, s.scored_at desc, s.id desc;

-- ---------------------------------------------------------------------
-- row level security
--
-- A candidate reads their own rows. Staff read the rows of candidates
-- they can already see (the EXISTS goes through the policy on
-- candidates). Writes go through resume_score_record() only.
-- ---------------------------------------------------------------------
alter table candidate_resume_scores      enable row level security;
alter table candidate_resume_score_queue enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'candidate_resume_scores'
                  and policyname = 'resume_scores_read') then
    create policy resume_scores_read on candidate_resume_scores for select
      using (candidate_id = app_candidate_id()
             or (app_role() in ('recruiter','bde','admin','client')
                 and exists (select 1 from candidates c where c.id = candidate_id)));
  end if;
end $$;

-- Runs as the READER (security_invoker), so resume_scores_read above and
-- the candidates policy inside its EXISTS both apply. As an owner-run
-- view the EXISTS saw every candidate, and a client could read the score
-- of anyone in the database. The WHERE below only narrows further.
create or replace view candidate_resume_score_visible_v
  with (security_invoker = true) as
  select l.* from candidate_resume_score_latest_v l
   where l.candidate_id = app_candidate_id()
      or (app_role() in ('recruiter','bde','admin','client')
          and exists (select 1 from candidates c where c.id = l.candidate_id));

-- ---------------------------------------------------------------------
-- queue: any change that could move the score
-- ---------------------------------------------------------------------
create or replace function resume_score_enqueue() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_id text;
begin
  -- Separate statements: a CASE naming new.candidate_id fails on the
  -- candidates table, whose rows have no such field.
  if tg_table_name = 'candidates' then
    v_id := new.id;
  elsif tg_op = 'DELETE' then
    v_id := old.candidate_id;
  else
    v_id := new.candidate_id;
  end if;
  if v_id is not null then
    insert into candidate_resume_score_queue (candidate_id) values (v_id)
    on conflict (candidate_id) do update set queued_at = now();
  end if;
  return null;
end $$;

drop trigger if exists resume_score_enqueue_cand on candidates;
create trigger resume_score_enqueue_cand
  after insert or update of name, email, phone, location, title, summary, education, exp, exp_years,
                            current_company, previous_companies, preferred_role, skills,
                            technical_skills, certifications, languages, projects,
                            resume_file, resume_uploaded_at, resume_text, resume_parse_error
  on candidates for each row execute function resume_score_enqueue();

do $$
begin
  if to_regclass('public.candidate_education') is not null then
    execute 'drop trigger if exists resume_score_enqueue_edu on candidate_education';
    execute 'create trigger resume_score_enqueue_edu after insert or update or delete on candidate_education
               for each row execute function resume_score_enqueue()';
  end if;
  if to_regclass('public.candidate_experience') is not null then
    execute 'drop trigger if exists resume_score_enqueue_exp on candidate_experience';
    execute 'create trigger resume_score_enqueue_exp after insert or update or delete on candidate_experience
               for each row execute function resume_score_enqueue()';
  end if;
end $$;

-- Internships / achievements columns arrived in 0087; queue on them too
-- when they exist (an ALTER TRIGGER cannot add columns, so a second one).
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_name = 'candidates' and column_name = 'internships') then
    execute 'drop trigger if exists resume_score_enqueue_sections on candidates';
    execute 'create trigger resume_score_enqueue_sections
               after update of internships, achievements on candidates
               for each row execute function resume_score_enqueue()';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- writing a score: the API has already checked who may ask
-- ---------------------------------------------------------------------
create or replace function resume_score_engine_guard() returns void
language plpgsql as $$
begin
  if not (app_role() = 'admin' and app_user_id() is null) then
    raise exception 'resume scores are written by the scoring engine only' using errcode = '42501';
  end if;
end $$;

create or replace function resume_score_record(
  p_candidate text, p_resume_id text, p_status text, p_total int, p_label text,
  p_sections jsonb, p_tips jsonb, p_ai_tips jsonb, p_engine text, p_fingerprint text)
returns bigint
language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  perform resume_score_engine_guard();
  insert into candidate_resume_scores (candidate_id, resume_id, status, total_score, label,
                                       section_scores, tips, ai_tips, engine, fingerprint)
  values (p_candidate, p_resume_id, p_status, p_total, p_label,
          coalesce(p_sections, '{}'), coalesce(p_tips, '[]'), coalesce(p_ai_tips, '[]'),
          coalesce(p_engine, 'rules'), p_fingerprint)
  returning id into v_id;
  delete from candidate_resume_score_queue where candidate_id = p_candidate;
  return v_id;
end $$;

/** The queue, oldest first, for the sweep. */
create or replace function resume_score_queue_take(p_limit int)
returns table (candidate_id text)
language plpgsql security definer set search_path = public as $$
begin
  perform resume_score_engine_guard();
  return query select q.candidate_id from candidate_resume_score_queue q
                order by q.queued_at limit greatest(1, least(p_limit, 500));
end $$;

/** Is this candidate waiting to be re-scored? (The queue has no policies.) */
create or replace function resume_score_is_queued(p_candidate text)
returns boolean
language plpgsql security definer set search_path = public as $$
begin
  perform resume_score_engine_guard();
  return exists (select 1 from candidate_resume_score_queue where candidate_id = p_candidate);
end $$;

/** Nothing to do for this one (e.g. unchanged fingerprint). */
create or replace function resume_score_queue_drop(p_candidate text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  perform resume_score_engine_guard();
  delete from candidate_resume_score_queue where candidate_id = p_candidate;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select on candidate_resume_scores to app_api;
    grant select on candidate_resume_score_visible_v to app_api;
    grant usage, select on sequence candidate_resume_scores_id_seq to app_api;
    grant execute on function resume_score_record(text, text, text, int, text, jsonb, jsonb, jsonb, text, text) to app_api;
    grant execute on function resume_score_queue_take(int) to app_api;
    grant execute on function resume_score_queue_drop(text) to app_api;
    grant execute on function resume_score_is_queued(text) to app_api;
  end if;
end $$;

-- Every candidate already in the portal gets a first score from the sweep.
insert into candidate_resume_score_queue (candidate_id)
select id from candidates
on conflict do nothing;

comment on table candidate_resume_scores is
  'Resume score history (0094): one row per scoring, written by resume_score_record() from api/src/resume/score.js. status unreadable has no total - never a 0.';
