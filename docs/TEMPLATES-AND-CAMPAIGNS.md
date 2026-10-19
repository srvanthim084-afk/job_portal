# Templates & Campaigns (Recruiter Portal)

A **Templates & Campaigns** button sits in the shared Recruiter Portal header (top right, before the bell / help / profile icons). It is added once, in `dashShell` (`web/index.html`), only when `role === 'recruiter'`, so every recruiter page has it and the Admin, Candidate and public pages do not. It opens one popup (`#tcRoot`, a second open is ignored) and closes with the X, Esc, a click outside, or a page change. The page underneath is never re-rendered.

## Templates tab
Channel (All / Call / Email / SMS / WhatsApp), Department, Approval state (Any / Approved / Waiting for approval / Changes needed), search, Archived toggle, and a Columns menu (remembered in the browser). Columns: Template, Channel, Used In, Department, Approval, Version, Actions.

Actions shown per row depend on who is looking (the API sends `canEdit / canReview / canArchive / canDuplicate`):

| Action | Who |
|---|---|
| View / details + version history | any recruiter or admin |
| Duplicate | anyone; the way to change a built-in template |
| Edit | the author, or an admin. Saving makes a new version |
| Approve / Changes needed (note required) | an admin, or a team lead who is not the author |
| Archive | the author or an admin |

Approval: an admin's own template is approved at once; anyone else's waits for review. Editing an approved template makes a new version that waits again. Built-in templates (`source = 'system'`: the notification events and the compose-box messages) are read-only. Only approved, non-archived templates reach the compose box (`GET /candidates/message-templates`).

## Campaigns tab
The AI calling campaigns the caller is allowed to see (`ai_call_campaigns` with job, owner and call counts). Approval and Version do not apply to campaigns and show "—".

## Where it lives
- `supabase/migrations/0157_comm_templates.sql` – extends `comm_templates` (call channel, department, used_in, approval, version, source, archive), adds `comm_template_versions`, SECURITY DEFINER writers, seeds the built-ins.
- `api/src/routes/comm-templates.js` – `/comm/templates*`, `/comm/campaigns`.
- `web/teamlink-templates-campaigns.js` – button + popup.
- `api/test/comm-templates.test.mjs` – 10 tests.
