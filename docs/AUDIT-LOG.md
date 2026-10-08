# Admin -> Audit Log (0119)

`#/admin/audit-log` (sidebar **Audit Log**, below Reports). One page that answers
"who did what, to which record, and when". Admin only: any other role gets 403 from
the API, and the entry is not in a recruiter's menu.

| Piece | Where |
|---|---|
| Page | `web/teamlink-audit-log.js` |
| API | `GET /api/admin/audit-log`, `GET /api/admin/audit-log/export` (`api/src/routes/ats-record.js`) |
| The list it reads | the view `admin_audit_events` (0111, extended in `0119_audit_log_page.sql`) |
| Checks | `api/test/teams.test.mjs` (Audit Log), `tools/verify-teams.mjs` (E1-E4) |

## What is in it

Every source the portal already writes, newest first:

* `audit_log`: candidates created, updated or deleted, resumes, documents,
  applications, interviews (0111), and from 0118 `RECRUITER_ASSIGNED`,
  `RECRUITER_REASSIGNED`, `RECRUITER_UNASSIGNED`, `RECRUITER_DEPARTMENT_CHANGED`,
  `RECRUITER_EMAIL_CHANGED` (old and new email), `RECRUITER_STATUS_CHANGED`,
  `TL_ROLE_CHANGED`, `CONTACT_COOLDOWN_OVERRIDDEN` (with the reason),
  `CONTACT_COOLDOWN_CHANGED`, and `AUDIT_LOG_EXPORTED`
* `application_stage_history`: every stage change
* `candidate_activity`: source changes
* `staff_audit`: client logins created
* `engagement_audit` (new in 0119): "contact anyway", blocked contacts, the
  override requests, shown as `contact.<action>`

Each row shows when (India time), who (name, email, role), the action in words, the
record (name, type, id) and a one-line summary of the values ("Email: a → b",
"Team lead: A → B · Department: X → Y", "Reason: ..."). **All details** opens every
recorded value.

## Search, filters, paging, export

* Search: record id, the person's email, the action, or any word in the details.
* Filters: action, record type, role, From / To (India dates, both inclusive).
  They combine, and changing one returns to page 1. **Clear** resets.
* Paging: 25 / 50 / 100 rows.
* **Export CSV** downloads the filtered list (at most 5000 rows; cells starting with
  `= + - @` are quoted so a spreadsheet does not run them). The export is itself
  written to the log (`AUDIT_LOG_EXPORTED`, with the filters and the row count).

## It cannot be edited

The page only reads. The API has no write route for the log, and the API's database
role has no right to change it: an update reaches no row, a delete or an insert is
refused (tested). Only the database functions that record an event
(`audit_write`, the triggers) add to it.

The panel that was at the foot of Reports is unchanged.
