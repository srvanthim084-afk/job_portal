-- ---------------------------------------------------------------------
-- 0016 — one ai_interview_start, not two
--
-- 0014 added a deadline parameter WITH a default, which creates a second
-- function rather than replacing the first: Postgres now has both
--
--     ai_interview_start(text,text,text,text,text,jsonb)
--     ai_interview_start(text,text,text,text,text,jsonb,int default 48)
--
-- and a six-argument call matches both, so it fails with "function ... is
-- not unique". The API always passes seven, which is why nothing broke in
-- the application — but any other caller, including a migration or a
-- console session, hits an ambiguous overload, and the old one does not
-- record a deadline at all.
--
-- The six-argument version is dropped so there is exactly one.
-- ---------------------------------------------------------------------

drop function if exists ai_interview_start(text, text, text, text, text, jsonb);
