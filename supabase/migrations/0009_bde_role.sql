-- ---------------------------------------------------------------------
-- 0009 — add 'bde' to the role enum
--
-- ALONE IN ITS OWN MIGRATION, ON PURPOSE.
--
-- PostgreSQL will not let a new enum value be USED in the same transaction
-- that adds it ("unsafe use of new value of enum type"). The runner sends
-- each migration file as one multi-statement simple query, which the server
-- wraps in an implicit transaction, so a file that both adds 'bde' and
-- creates a policy referring to it would fail every time.
--
-- Splitting it is the standard remedy: this file adds the value, 0010 uses
-- it. Nothing else belongs here.
--
-- BDE - Business Development Executive. They source candidates and push
-- those records into the agency's own ATS, which is a separate product
-- outside this system.
-- ---------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_enum e
      join pg_type t on t.oid = e.enumtypid
     where t.typname = 'user_role' and e.enumlabel = 'bde'
  ) then
    alter type user_role add value 'bde';
  end if;
end $$;
