-- ---------------------------------------------------------------------
-- 0065 — "no, I did not apply"
--
-- A redirect application finishes on somebody else's website, so this
-- portal records that the candidate was handed the official link and
-- nothing more. When they come back it asks whether they went through
-- with it, and there was no way to record the honest answer "no".
--
-- The vocabulary had `applied`, `applied_unconfirmed`, `withdrawn` and
-- the rest. None of them fits: `withdrawn` means they applied and then
-- pulled out, which is a different fact about a different sequence of
-- events, and recording it would tell a recruiter the candidate had
-- once been in the running.
--
-- `not_applied` is TERMINAL for the application row and NOT terminal for
-- the job: the posting goes back into the candidate's recommended list,
-- which is what the brief asks for and what a candidate expects after
-- saying "not yet".
-- ---------------------------------------------------------------------

insert into external_application_statuses (id, label, sort_order, terminal) values
  ('not_applied', 'Not Applied', 95, true)
on conflict (id) do update set
  label = excluded.label,
  sort_order = excluded.sort_order,
  terminal = excluded.terminal;

comment on table external_application_statuses is
  'The vocabulary for an external application. Separate from `stages` on purpose: a job somebody else advertised does not move through TeamLink''s pipeline.';
