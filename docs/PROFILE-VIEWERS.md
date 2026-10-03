# Who viewed my profile

A candidate can see who looked at their profile, when, and for which role -
without ever learning a client's name or a viewer's contact details.

## What the candidate sees

`#/candidate/viewers` (menu: **Who viewed my profile**, after Profile Performance):

- three numbers for the last 30 days, each against the 30 days before:
  **Profile views**, **Search appearances**, **Times shortlisted**
- a bar per week for the last 8 weeks
- the list, newest first, 20 per page:
  - `Priya (TeamLink Recruiter) viewed your profile for Medical Coder · 2 hours ago`
  - `A hiring team reviewed your profile for Medical Coder · yesterday`
- searches they appeared in: `Your profile appeared in a search for Java Developer, Hyderabad`
- when views are few: a tip linking to the resume score
  (`Profile score 58. Next step: Add these skills ... Stronger profiles get more views.`)
- the daily summary opt-ins (email, WhatsApp)

Also: a card on Home (`18 profile views this month`), the real views in Profile
Performance's **Profile viewed** filter (it used to be one line read out of the
browser), and the search-appearance count there and on Home comes from the
server too.

## The display rules (one place: `profile_viewer_display_name()` in 0093)

| Viewer | Shown as |
|---|---|
| TeamLink recruiter / BDE | `<first name> (TeamLink Recruiter)`, or `A TeamLink recruiter` when the administrator turns names off |
| administrator | `A TeamLink recruiter` |
| client (hiring team) | always `A hiring team` |

The role title is shown only when the job is one the candidate can already see
(open on the board, or one they applied to); otherwise no role. Never an id, an
email, a phone, a company or a client name, and never the word "Client" (0051).
The search sample is role + city only; a sample that names any company on the
board is dropped.

## Recording

- `POST /api/candidates/:id/viewed { jobId?, source }` - source is `profile`,
  `resume`, `search_card` or `application`. The **viewer and role come from the
  session**, never the body (`profile_view_record()` reads `app_user_id()` /
  `app_role()`); a body that names a viewer is ignored.
- One row per viewer, per IST day, per job: the same recruiter opening the same
  profile again that day only increments `view_count`.
- Not recorded: a candidate looking at themselves; an administrator's
  **Login As** session (`sessions.impersonated_by`, set by the login-as route);
  background engines (no user id); a profile the caller cannot read under RLS.
- The browser module records: opening `#/recruiter/candidate-profile?id=…`, the
  resume viewer (`tlViewResume`), and a client's Shortlisted screen (each
  shortlisted candidate, once the role is known).

### Search appearances - the page shown, not the match set

Find Candidates fetches a window of up to 200 matches and pages in the browser,
so counting every returned row would credit people nobody saw. Instead
`GET /api/candidates` returns an `appearanceToken` (HMAC over the caller, the
time, the returned ids and a role/city sample) whenever the request is a search
(some criterion given). The page then calls
`POST /api/candidates/search-appearances { token, ids }` with the ids actually on
screen. The server credits only ids inside the token, only for the user it was
issued to, within two hours, once per id per token, and skips candidates who are
private (`is_private`) or hid themselves from search
(`user_prefs.teamlink_profile_visibility_v1`).

## Notifications

- No message per view. At **19:00 IST** a sweep (every 10 minutes, idempotent)
  sends one digest to each candidate who had views that day:
  `3 recruiters viewed your profile today` (or `… recruiters and hiring teams …`).
  In-app always (`PROFILE_VIEWS_DIGEST`, deduplicated per day); email and WhatsApp
  only if the candidate turned them on on the page, has not opted out of that
  channel, and is not do-not-contact. WhatsApp also needs an approved template
  (Notification Settings) - without one it is recorded `not_configured`.
  `candidate_profile_view_digests (candidate, day)` is claimed before sending, so
  it never goes twice.
- Shortlisting stays an instant notification (unchanged).
- The prototype's `RECRUITER_VIEWED` notification no longer names the company:
  `Priya (TeamLink Recruiter) viewed your application for Medical Coder.`

## Administrator settings

Notification Settings (admin) → **Who viewed my profile**:

- Show recruiter first names to candidates (default on)
- Daily profile-view digest (default on)

Stored in `app_settings.profile_viewers`; `GET/PUT /api/admin/profile-viewer-settings`.

## Retention and access

- Views, appearances and digest rows older than **180 days** are deleted by the
  same daily sweep (`profile_views_cleanup()`).
- RLS: candidates have no policy on the raw tables and read through
  `candidate_profile_viewers_v` and `profile_viewer_summary()`, keyed on
  `app_candidate_id()`. Recruiters, BDEs and admins may read view rows for
  candidates they can already see. Nobody can insert, update or delete rows
  through the API; the engine functions refuse any signed-in person.

## API

| Method | Path | Who |
|---|---|---|
| POST | `/api/candidates/:id/viewed` | staff (others: `recorded:false`) |
| POST | `/api/candidates/search-appearances` | staff |
| GET | `/api/candidate/profile-viewers?page=` | candidate |
| PUT | `/api/candidate/profile-viewers/prefs` | candidate |
| GET/PUT | `/api/admin/profile-viewer-settings` | admin |

## Files

- `supabase/migrations/0093_profile_viewers.sql`
- `api/src/routes/profile-viewers.js`, `api/src/profile-viewers/appearances.js`,
  `api/src/notify/profile-view-digest.js`
- `api/src/routes/candidates.js` (one field: `appearanceToken`),
  `api/src/routes/staff.js` (marks Login As sessions)
- `web/teamlink-profile-viewers.js`
- Tests: `api/test/profile-viewers.test.mjs`; browser: `tools/verify-profile-viewers.mjs`
  (set `TL_CLIENT_EMAIL` to a client login on the instance for the hiring-team step).
