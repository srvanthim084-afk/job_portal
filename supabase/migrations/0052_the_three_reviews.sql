-- ---------------------------------------------------------------------
-- 0052 — the three reviews, and the client's own interview
--
-- A profile is reviewed three times before anybody is placed, by three
-- different people, and the pipeline named only one of them:
--
--   THE RECRUITER reads the CV and decides whether it is worth sending
--     on.  This was "Shortlisted", which says what happened to the
--     candidate but not who is now holding the file.
--   THE BDE owns the client relationship and decides whether the profile
--     is one they are willing to put their name to. This was "With BDE",
--     which says where it is but not that somebody has to DO something.
--   THE CLIENT decides whether to interview. That one was already named.
--
-- Two relabels, no new stage and no data migration: every one of the
-- existing applications keeps the exact stage id it already had, and the
-- kanban, the reports and the history all keep working because none of
-- them was ever keyed on the words.
--
-- THE CLIENT'S INTERVIEW IS A NEW STAGE, because it genuinely did not
-- exist. "Interview Scheduled" and "AI Interview Done" are TeamLink's own
-- AI interview and they sit early, before the profile has even reached
-- the client - so an application waiting on the client's interview had
-- nowhere to be except "Client Review", alongside profiles the client had
-- not yet opened. Those are different problems for a desk chasing them.
--
-- WHAT THE CANDIDATE READS. Three internal review steps are one step to
-- them, and none of them names a client or a BDE:
--
--   recruiter  … Recruiter Review · BDE Review · Client Review · Client Interview …
--   candidate  … Shortlisted ·      (hidden)   · Recruiter Review · Interview …
--
-- "Shortlisted" is kept as the candidate's word for the recruiter's
-- review deliberately. It is the one stage on the rail that is good news,
-- and replacing it with the neutral "Recruiter Review" would take that
-- away for no reason - the relabel is for the desk, not for them.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- the three reviews
-- ---------------------------------------------------------------------

update stages set label = 'Recruiter Review',
                  candidate_label = 'Shortlisted'
 where id = 'shortlisted';

update stages set label = 'BDE Review',
                  candidate_label = 'Recruiter Review'
 where id = 'with_bde';

-- client_review keeps its label; 0051 already gave it the candidate's.

-- ---------------------------------------------------------------------
-- the client's interview
--
-- sort_order 65 puts it between Client Review (60) and Offer Extended
-- (70) - the room 0042 made by renumbering everything by tens, used for
-- exactly this.
-- ---------------------------------------------------------------------

insert into stages (id, label, kanban, sort_order, notify_candidate, client_visible, candidate_label)
values ('client_interview', 'Client Interview', false, 65, true, true, 'Interview')
on conflict (id) do update set
  label            = excluded.label,
  kanban           = excluded.kanban,
  sort_order       = excluded.sort_order,
  notify_candidate = excluded.notify_candidate,
  client_visible   = excluded.client_visible,
  candidate_label  = excluded.candidate_label;

/*
 * WHO HANDS OVER TO WHOM.
 *
 * The order of the reviews is data, not a rule written into four screens
 * that will disagree within a month. `next_stage` is what the "send it
 * on" button moves to, and `owner` is who is holding the file while it
 * sits there - which is the question a recruiter opening the board is
 * actually asking.
 *
 * NULL next_stage means this stage does not hand on automatically:
 * Offer, Selected, Joined, Hold and Rejected are all decisions somebody
 * makes, not a queue somebody clears.
 */
alter table stages
  add column if not exists owner      text,
  add column if not exists next_stage text references stages(id);

update stages set owner = 'recruiter' where id in
  ('applied', 'ai_screening', 'shortlisted', 'interview_scheduled', 'ai_interview_done');
update stages set owner = 'bde'       where id in ('with_bde');
update stages set owner = 'client'    where id in ('client_review', 'client_interview');

/* The handover chain, in the order the desk works it. */
update stages set next_stage = 'with_bde'         where id = 'shortlisted';
update stages set next_stage = 'client_review'    where id = 'with_bde';
update stages set next_stage = 'client_interview' where id = 'client_review';

/*
 * After the client's interview the file goes BACK to the BDE, who records
 * the verdict. That is not a single next stage - it is selected or
 * rejected - so it is left null and the decision is made explicitly.
 */

comment on column stages.owner is
  'Who is holding the file while an application sits at this stage: recruiter, bde or client. Null where nobody is waiting on anybody.';
comment on column stages.next_stage is
  'Where the handover button moves an application from this stage. Null where the move is a decision rather than a queue.';

/*
 * THERE IS NO VERDICT FUNCTION HERE, ON PURPOSE.
 *
 * The first draft of this migration had one, and it was a mistake:
 * PUT /applications/:id/status already validates the stage, carries the
 * note, lets the trigger write the history AND tells the candidate on
 * every channel they have. A second write path would have moved the
 * stage correctly and told nobody - the exact failure the route was
 * written to prevent. Recording a client verdict is a move to
 * "selected" or "rejected" through that route, like every other move.
 */
