-- ---------------------------------------------------------------------
-- 0119 — the Audit Log page
--
-- The admin audit log was a panel at the bottom of Reports. It is a page
-- of its own now (Admin -> Audit Log). Two small things come with it:
--
--   * "Contact anyway", "blocked" and the override requests of 0091 are
--     in engagement_audit, which the audit view did not list. They are
--     added to admin_audit_events as 'contact.<action>'.
--
--   * Exporting the log is itself written to the log, so audit_write()
--     (0111, SECURITY DEFINER) may be called by the API.
--
-- Nothing is deleted or rewritten; the view gains one source.
-- ---------------------------------------------------------------------

create or replace view admin_audit_events with (security_invoker = true) as
  select 'a' || l.id as id, l.created_at as at, l.actor_user_id, l.actor_role,
         l.action, l.entity, l.entity_id, l.detail
    from audit_log l
  union all
  select 'h' || h.id, h.created_at, h.changed_by,
         coalesce(h.source, case when h.changed_by is null then 'system' else 'recruiter' end),
         'status.changed', 'application', h.application_id,
         jsonb_build_object('from', h.from_stage, 'to', h.to_stage, 'override', h.is_override)
    from application_stage_history h
   where h.action = 'stage' and app_is_admin()
  union all
  select 'c' || ca.id, ca.created_at,
         case when ca.actor ~ '^[0-9a-fA-F-]{36}$' then ca.actor::uuid end,
         case when ca.actor ~ '^[0-9a-fA-F-]{36}$' then 'staff' else coalesce(ca.actor, 'system') end,
         'candidate.' || ca.kind, 'candidate', ca.candidate_id,
         ca.detail - 'fromDetail' - 'toDetail' - 'detail'
    from candidate_activity ca
   where app_is_admin()
  union all
  select 's' || s.id, s.created_at,
         case when s.actor_id ~ '^[0-9a-fA-F-]{36}$' then s.actor_id::uuid end, 'admin',
         'staff.' || s.action, s.target_kind, s.target_id, '{}'::jsonb
    from staff_audit s
   where app_is_admin()
  union all
  select 'e' || ea.id, ea.created_at, ea.actor, 'recruiter',
         'contact.' || ea.action, 'candidate', ea.candidate_id,
         ea.detail || jsonb_build_object('jobId', ea.job_id, 'roleKey', ea.role_key)
    from engagement_audit ea
   where app_is_admin();

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function audit_write(text, text, text, jsonb) to app_api;
  end if;
end $$;
