-- ---------------------------------------------------------------------
-- 0072 — two facts a candidate wants before they apply
--
-- GENDER. Some of the roles this agency fills are stated by the client
-- as being for women or for men - nursing and domestic placements in
-- particular, and the Gulf postings where the visa itself is issued that
-- way. That was being written into the description as a sentence, which
-- means it cannot be filtered on, cannot be reported on, and is missed
-- by anybody skimming.
--
-- ACCOMMODATION. Whether the employer houses you is, for somebody
-- relocating from a district town to a city or abroad, frequently the
-- deciding fact. It was not recorded at all.
--
-- EXISTING JOBS DO NOT BREAK. `gender` is nullable - twenty-five jobs
-- already exist and nobody has said which they are, and inventing an
-- answer for them would be worse than leaving it blank. `accommodation`
-- defaults to false, which is what "nobody said" means in practice and
-- is what the form defaults to.
-- ---------------------------------------------------------------------
alter table jobs
  /*
   * Left as text rather than an enum. The two values the form offers are
   * checked below, but a client feed or an import that carries something
   * else should land in the column and be visible, not be rejected at
   * the boundary and lost.
   */
  add column if not exists gender text,
  add column if not exists accommodation boolean not null default false;

alter table jobs
  drop constraint if exists jobs_gender_known;

alter table jobs
  add constraint jobs_gender_known
  check (gender is null or gender in ('Female', 'Male'));

/* Filtering on "women's roles with accommodation" should not read every
   job; both are low-cardinality, so a partial index on the stated ones
   is what earns its keep. */
create index if not exists jobs_gender_idx on jobs (gender) where gender is not null;
create index if not exists jobs_accommodation_idx on jobs (accommodation) where accommodation;
