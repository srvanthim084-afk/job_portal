-- ---------------------------------------------------------------------
-- 0146 - TeamLink's own "New application" alerts are not applications to review
--
-- Email import read the portal's own alert emails ("New application: Pharmacology" - "<Name> applied for
-- <Job> (Job ID ...). Application ID TL-APP-...") back out of the recruiter's inbox and queued each one as
-- "No candidate name could be read from this email" - needing review, though the candidate had already
-- applied and has an Application ID. The classifier now recognises them (api/src/intake/parse.js); this
-- takes the ones already waiting off the queue, saying why. Nothing is deleted: they stay in the list as
-- ignored, like any email a recruiter marks "Not an application".
-- ---------------------------------------------------------------------
update email_messages
   set status = 'ignored',
       reason = 'TeamLink''s own new-application alert - the candidate already applied through the portal and has an Application ID',
       processed_at = coalesce(processed_at, now())
 where status in ('needs_review', 'needs_mapping')
   and candidate_id is null
   and application_id is null
   and lower(coalesce(subject, '')) like 'new application:%'
   and coalesce(snippet, raw, '') ~* 'application id tl-app-[0-9]{4}-[0-9]{3,}'
   and coalesce(snippet, raw, '') ~* ' applied for ';
