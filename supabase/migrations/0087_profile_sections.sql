-- ---------------------------------------------------------------------
-- 0087 — the profile sections a resume has and the profile did not
--
-- Internships / training, achievements and "other" professional links
-- had nowhere to go: the resume parser read past them and the profile
-- page had no card for them. Projects, LinkedIn, GitHub, portfolio,
-- available-from, immediate joiner and relocation already exist (0001,
-- 0057); these are the missing ones.
--
-- Additive only. Nothing is renamed, nothing is backfilled - an empty
-- list is the honest value for every profile that has never said.
-- ---------------------------------------------------------------------

alter table candidates
  add column if not exists internships            jsonb not null default '[]'::jsonb,
  add column if not exists achievements           jsonb not null default '[]'::jsonb,
  add column if not exists other_links            jsonb not null default '[]'::jsonb,
  add column if not exists preferred_joining_date date,
  add column if not exists additional_info        text;

comment on column candidates.internships is
  'Internships and training: [{org, role, duration, desc, tech}]. From the candidate or their resume.';
comment on column candidates.achievements is
  'Achievements and awards: [{title, org, date, desc}].';
comment on column candidates.other_links is
  'Professional links beyond LinkedIn, GitHub and portfolio: [{label, url}].';
