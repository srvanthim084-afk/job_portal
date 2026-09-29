-- ---------------------------------------------------------------------
-- 0051 — the candidate is never shown the word "Client"
--
-- A candidate opening My Applications saw their pipeline read
--
--     Applied · AI Screening · Shortlisted · Interview Scheduled ·
--     AI Interview Done · CLIENT REVIEW · Offer Extended · Selected · Joined
--
-- and "Client Review" is not their business. It tells them TeamLink is an
-- agency placing them somewhere else, it invites the obvious next
-- question - which client? - and it is the one stage on the rail that
-- describes our commercial arrangement rather than their application. As
-- far as the candidate is concerned the people reviewing them are
-- TeamLink, and what they should read is "Recruiter Review".
--
-- WHY A COLUMN AND NOT A RENAME. The recruiter desk genuinely needs the
-- distinction: a profile sitting with the BDE is not a profile sitting
-- with the client, and the whole point of migration 0042 was to stop
-- those two looking identical. Renaming the stage would take that back.
-- So the stage keeps its name and gains a second one - what to call it in
-- front of a candidate - exactly as 0042 gave every stage its own
-- `notify_candidate` and `client_visible` rather than hardcoding lists.
--
-- A NULL candidate_label MEANS "the ordinary label is fine", which is
-- true of almost every stage. Only the ones that expose how the desk
-- works internally need a second wording, and stating that as absence
-- rather than as a duplicated string keeps the two in step: renaming
-- "Offer Extended" later changes it for everyone, as it should.
-- ---------------------------------------------------------------------

alter table stages
  add column if not exists candidate_label text;

-- COMMENT ON takes a string LITERAL, not an expression: a || b is a
-- syntax error here, and it aborts the whole migration.
comment on column stages.candidate_label is
  'What a CANDIDATE is shown for this stage, when that must differ from the internal label. NULL means use label. The candidate is never shown the word Client (0051).';

update stages set candidate_label = 'Recruiter Review' where id = 'client_review';

/*
 * With BDE never reaches a candidate's screen - notify_candidate is
 * false and the rail omits it - but it is given a candidate wording
 * anyway, because "omitted from the rail" and "safe to display" are
 * different promises and only one of them is enforced here. If any screen
 * ever does show it, it says something a candidate can read instead of
 * naming an internal role.
 */
update stages set candidate_label = 'Recruiter Review' where id = 'with_bde';

/*
 * What to call a stage for a given audience.
 *
 * One place, so a screen, an email and an SMS cannot disagree about what
 * a candidate is told. Any audience other than 'candidate' gets the
 * internal label, which is the safe default: a new caller that forgets to
 * say who is asking shows the recruiter's wording to a recruiter, never
 * the other way round.
 */
create or replace function stage_label(p_stage text, p_audience text default 'internal')
returns text
language sql stable security definer set search_path = public as $$
  select case
           when p_audience = 'candidate'
             then coalesce((select candidate_label from stages where id = p_stage),
                           (select label           from stages where id = p_stage),
                           p_stage)
           else coalesce((select label from stages where id = p_stage), p_stage)
         end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function stage_label(text, text) to app_api;
  end if;
end $$;
