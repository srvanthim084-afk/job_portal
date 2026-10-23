-- ---------------------------------------------------------------------
-- 0163 - requirements created from an email subject lose the symbols a board put in front of the title
--
-- Shine sent "???? Hiring for Prosthodontist - Dental" (the emoji arrived as question marks), and the requirement was created with
-- that exact text. The reader now strips leading symbols and "Hiring for" (roleTitle); this renames the requirements already created
-- that way, unless a requirement with the clean title already exists in the same company (then it is left alone, never merged).
-- ---------------------------------------------------------------------
update jobs j
   set title = btrim(regexp_replace(regexp_replace(j.title, '^[^A-Za-z0-9]+', ''), '^hiring\s+for\s+', '', 'i'))
 where j.source = 'intake'
   and j.title ~ '^[^A-Za-z0-9]+'
   and length(btrim(regexp_replace(regexp_replace(j.title, '^[^A-Za-z0-9]+', ''), '^hiring\s+for\s+', '', 'i'))) >= 2
   and not exists (
     select 1 from jobs o
      where o.id <> j.id and o.company_id is not distinct from j.company_id and not o.archived
        and lower(btrim(o.title)) = lower(btrim(regexp_replace(regexp_replace(j.title, '^[^A-Za-z0-9]+', ''), '^hiring\s+for\s+', '', 'i'))));
