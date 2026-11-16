-- Imports that were run before the Audit Log started to record them (founder 2026-11-14: "backfill cheyyu").
-- Every row of candidate_imports gets ONE 'candidate.imported' row in audit_log, dated when the import ran and attributed to
-- the person who ran it, so Recruiter Activity (and its CSV) shows who imported what, also for the older uploads.
-- Idempotent: an import that already has its row (written live since the change, or by an earlier run of this file) is skipped.
-- Nothing in candidate_imports or in any candidate is changed.
insert into audit_log (actor_user_id, actor_role, action, entity, entity_id, detail, created_at)
select ci.imported_by,
       case when ci.recruiter_id is not null then 'recruiter' else 'system' end,
       'candidate.imported', 'candidate', ci.id,
       jsonb_build_object(
         'title', ci.created_count || ' new, ' || ci.merged_count || ' merged, ' || ci.skipped_count || ' skipped of ' || ci.total_rows || ' rows'
                  || case when ci.filename is not null then ' (' || ci.filename || ')' else '' end,
         'filename', ci.filename, 'format', ci.format, 'total', ci.total_rows, 'created', ci.created_count,
         'merged', ci.merged_count, 'skipped', ci.skipped_count, 'backfilled', true),
       ci.created_at
  from candidate_imports ci
 where not exists (select 1 from audit_log a where a.action = 'candidate.imported' and a.entity_id = ci.id);
