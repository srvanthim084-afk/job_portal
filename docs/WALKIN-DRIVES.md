# Walk-in drives — replaced by walk-in jobs

The separate **Walk-in Drives** module (migrations `0099`, `0103`; its own
pages `#/walkins`, `#/candidate/walkins`, `#/recruiter/walkins`,
`#/admin/walkins`; its `/api/*walkin-drives*` routes; its navigation items)
was retired on 2026-10-05 by the owner's decision: **walk-in is a job type
inside Jobs, not a section.** See [WALKIN-JOBS.md](WALKIN-JOBS.md).

What happened to it (0106):

- Every `walkin_drives` row became a walk-in job (`jobs.posting_kind =
  'walkin'`, id `j_wk_<drive id>`), with its date, times, venue, full address,
  map link, documents to carry, contact and seats. `walkin_drive_job_map`
  records which job each drive became.
- Every registration that was not cancelled became an application to that
  job (id `app_wk_<registration id>`, source `walkin_drive`), at the walk-in
  stage it had reached (`registered` / `attended` / `no_show` when 0107's
  walk-in stages exist, else the ordinary first stage).
- `walkin_drives_migrate()` does this once, at API boot, and never again for
  the same drive or registration.
- **Nothing was dropped.** `walkin_drives`, `walkin_registrations` and
  `walkin_notifications` keep every row; nothing reads or writes them any
  more except that one-time move, which only reads.

Removed files: `api/src/routes/walkin-drives.js`, `api/src/notify/walkin.js`,
`web/teamlink-walkin-drives.js`, `api/test/walkin-drives.test.mjs`,
`tools/verify-walkin-drives.mjs`. Their replacements are
`api/src/routes/apply-form.js`, `api/src/portal/walkin-jobs.js`,
`api/src/notify/walkin-jobs.js`, `web/teamlink-walkin-jobs.js`,
`api/test/walkin-jobs.test.mjs` and `tools/verify-walkin-jobs.mjs`.
