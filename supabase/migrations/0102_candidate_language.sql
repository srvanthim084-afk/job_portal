-- ---------------------------------------------------------------------
-- 0102 — the candidate's preferred language
--
-- The language a candidate wants TeamLink to talk to them in: English,
-- Telugu or Hindi. Not to be confused with `languages` (0001), the
-- languages they SPEAK, which is a profile fact a recruiter reads.
--
-- THE COLUMN ALREADY EXISTS. 0018 (AI calling) added
-- candidates.preferred_language as plain text and the calling agent
-- writes the language a person actually spoke on a call into it ("worth
-- remembering for next time"; only en / hi / te are ever detected). It is
-- the same fact - the language to use with this person - so the portal
-- uses the same column instead of a second one that could disagree.
--
-- NULL STAYS "NEVER CHOSEN". There is deliberately no backfill and no
-- column default: to the calling agent NULL means "use the admin's default
-- call language" (ai_call_settings.default_language), and a default of
-- 'en' would silently override that for every candidate. Everywhere in the
-- portal NULL is read as English (toCandidate passes NULL through; the kit,
-- the assistant and the profile card treat it as English).
--
-- What this migration adds is the rule: only en | te | hi (or NULL).
-- Anything else already stored is normalised first (case, spaces), and
-- whatever is still not one of the three is cleared rather than kept as
-- a value no reader understands.
--
-- Read by:
--   - the interview prep kit (tips, bring-list and the page's headings
--     in Telugu or Hindi; the questions stay English)
--   - the career assistant's rules engine ("Basic mode"), as the fallback
--     when a message does not show which language it is in
--   - the home page's career suggestion card
--   - the AI calling agent (as before)
--
-- Written through the existing rules only: the profile PUT under
-- candidates_self_write (the candidate, an owning recruiter, an admin),
-- the registration form (as the new candidate), and the calling agent's
-- definer function (0018). No new writer.
-- ---------------------------------------------------------------------

alter table candidates
  add column if not exists preferred_language text;

update candidates
   set preferred_language = lower(btrim(preferred_language))
 where preferred_language is not null
   and preferred_language <> lower(btrim(preferred_language))
   and lower(btrim(preferred_language)) in ('en', 'te', 'hi');

update candidates
   set preferred_language = null
 where preferred_language is not null
   and preferred_language not in ('en', 'te', 'hi');

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'candidates_preferred_language_chk') then
    alter table candidates add constraint candidates_preferred_language_chk
      check (preferred_language is null or preferred_language in ('en', 'te', 'hi'));
  end if;
end $$;

comment on column candidates.preferred_language is
  'The language to use with the candidate: en | te (Telugu) | hi (Hindi); NULL = never chosen (English in the portal, the admin default on calls). Not `languages` (the ones they speak).';
