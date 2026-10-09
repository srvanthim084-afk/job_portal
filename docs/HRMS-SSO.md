# Single sign-on from TeamLink HRMS

A recruiter or admin who is signed in to TeamLink HRMS (the TeamLink.Enterprise
app: HRMS, ATS and Accounts) opens the Job Portal from HRMS without signing in
again.

The two are separate applications on separate origins, each with its own
sessions:

- HRMS keeps a Bearer JWT in `localStorage`.
- The portal keeps an httpOnly cookie. When TeamLink.Enterprise embeds the
  portal at `/jobs` it is the same site, but the session is still a different
  one.

So HRMS hands the user over with a short-lived signed token, and the portal
opens its own session.

## The flow

```
HRMS sidebar "Job Portal" (Recruiter / Admin only)
  -> HRMS /sso/job-portal                    (signed out? HRMS login first, then back)
  -> POST HRMS /api/sso/job-portal/launch    -> { url }
  -> <portal>/hrms-sso.html#token=<jwt>&next=#/recruiter/...
       1. history.replaceState removes the token from the address bar
       2. POST /api/auth/hrms-sso { token, next }   (with the CSRF cookie/header)
       3. the portal checks the token, opens a session (cookie) and audits the login
  -> <portal>/#/recruiter/home  (or `next`)  — header shows "← Back to HRMS"
```

The token travels in the URL fragment. A fragment is never sent to a server,
never logged and never put in a Referer header. Neither app ever puts a
password or a long-lived token in a URL.

## The token

HRMS signs it as HS256 with `HRMS_SSO_SECRET`. The portal (`api/src/sso/hrms.js`) checks each field:

| claim | value | checked |
|---|---|---|
| header `alg` | `HS256` | anything else (`none`, RS*) is refused |
| `iss` | `teamlink-hrms` | exact |
| `aud` | `teamlink-job-portal` | exact |
| `iat`, `exp` | `exp = iat + 60` | lifetime at most 60 s, not expired, not issued in the future (30 s clock skew allowed) |
| `jti` | random UUID | **single use**: kept in `hrms_sso_tokens`; a second use is refused |
| `sub`, `name`, `email` | the HRMS user | the account is matched by `email` |
| `role` | `SUPER_ADMIN`, `ADMIN` or `RECRUITER` | mapped below |
| `sid` | the HRMS sign-in session id | ties the two sessions together |

Every refusal of the token itself gets the same answer:
`401 { code: SSO_TOKEN_EXPIRED | SSO_TOKEN_INVALID, message: "Session expired. Please open the Job Portal from HRMS again." }`.
The page shows that message with a **Back to HRMS** button.

## Roles and accounts

| HRMS | Job Portal |
|---|---|
| Super Admin, Admin | admin |
| ATS role Recruiter | recruiter |
| anyone else (Employee, Accountant, TL, HR, …) | no access: HRMS hides the item, and both apps answer **Access denied** with **Back to HRMS** |

**Accounts are matched by email. Nothing is created.** The portal account
must already exist with the same email and the mapped role, and it must be
active. Otherwise the page says *Access denied* and explains why:

- there is no account for that email;
- the email belongs to a different role (for example, an HRMS recruiter whose
  email is a candidate login here);
- the account is suspended.

A token never makes an account more than it already is.

Why match only:

- A portal recruiter is more than a login. Company, department and team-lead
  assignment decide what they may see (0118), and HRMS does not carry those.
- Creating admin accounts from a token would make a mistake in the HRMS role
  data a privilege escalation here.

A portal administrator adds the recruiter once (Recruiters → Add), using the
same email the person has in HRMS. From then on the person signs in from
HRMS.

After that, the session is an ordinary portal session for that account. Every
row-level-security rule applies as usual, so an SSO recruiter sees only their
own jobs and data, and a team lead also sees their team's.

A recruiter account that an admin created carries a temporary password. When
the account is opened from HRMS, the portal does **not** ask the person to
change that password, because the portal password is never used there.

## One session, one timeout, one logout

A portal session opened from HRMS stores the HRMS `sid` in `sessions.hrms_sid`.

- **Shared 30-minute inactivity timeout.** `hrmsSessionGate()` runs after
  `attachSession()` on every API call.
  - At most once a minute, it calls `POST {HRMS_API_URL}/api/sso/job-portal/session`.
    It always calls before declaring the session idle.
  - The call carries the user's last activity in the portal. HRMS answers from
    one timer, and activity in either app keeps both sessions alive.
  - If HRMS says the session has ended, the portal session ends too.
  - If HRMS cannot be reached, the portal falls back on its own clock (the
    same 30 minutes).
- **Polling is not activity.** The page sends `x-tl-idle-ms` (milliseconds
  since the person last touched it) with each request. Activity is `now − idle`,
  so a screen that refreshes itself never keeps a session alive. A request
  without the header counts as activity, which is how every request counted
  before.
- **HRMS Sign Out → portal.** HRMS calls `POST /api/auth/hrms-sso/logout`
  with a token signed for audience `teamlink-job-portal-backchannel`. Every
  portal session with that `sid` ends. An open portal tab notices within a
  minute through its heartbeat and goes to HRMS.
- **Portal logout → HRMS.** `POST /api/auth/logout` on an HRMS session first
  calls `POST {HRMS_API_URL}/api/sso/job-portal/logout` with audience
  `teamlink-hrms-backchannel`. The page then goes to the HRMS login.
- **Signed out of HRMS, then opening a portal recruiter or admin page.** The
  page goes to `{HRMS_URL}/sso/job-portal?next=<that page>`. HRMS asks for its
  login, then sends the person straight back to the page they wanted.
  `HRMS_SSO_STAFF_REDIRECT=0` keeps the portal's own login screen instead.
- Each back-channel token carries its own `jti`, is valid for 60 s, and uses an
  audience a launch token can never carry.

## Audit log

The first time an HRMS sign-in opens the portal, the portal writes one
`audit_log` row:

- Action `auth.login_hrms`, shown as **Login (via HRMS)**.
- The date and time.
- The actor is the user.

Opening the portal again in the same HRMS sign-in (moving back and forth, a
second tab, a new token) writes nothing more. The once-only rule is kept in
`hrms_sso_logins` by `sid`. Tokens and the secret are never written to the
log.

**Recruiter Login / Logout / Time in Portal (migration 0125, built
separately).** When its `portal_session_*` functions are in the database, the
recruiter login goes through them:

- The login calls `portal_session_start(token, 'hrms', 'auth.login_hrms')`.
  That writes the one Login (via HRMS) row and opens the portal session.
- An HRMS logout closes the portal session as **Logout**
  (`hrms_sso_end_sid`).
- The shared idle timeout closes it as **Auto logged out**, dated at the last
  real activity (`hrms_sso_expire`).
- A portal logout goes through 0125's own `logout()`.
- A second browser in the same HRMS sign-in joins that sign-in's open portal
  session (`hrms_sso_join_portal_session`), so it is not recorded as a new
  login or as "session carried over".

Without 0125, the route writes the `auth.login_hrms` row itself. The lookup
happens at run time, so the two migrations do not depend on each other.
This was checked by merging the two branches in a throwaway tree: both test
suites passed together (31/31).

0125's `api/src/audit/recruiter-activity.js` names its extension point for
this. When the two branches meet, add these two entries there so its
Recruiter Audit Log labels and counts the row:

- `LOGIN_METHODS.hrms = 'auth.login_hrms'`
- `{ code: 'auth.login_hrms', label: 'Login (via HRMS)', group: 'session' }` in
  `ACTIVITY`

The portal's own idle column for this feature is `sessions.hrms_active_at`.
It holds real activity only, from `x-tl-idle-ms`. It is deliberately separate
from 0125's `last_seen_at`, which every request moves.

## Configuration

Portal (`.env`):

| variable | meaning |
|---|---|
| `HRMS_SSO_SECRET` | the shared secret, at least 32 characters, the same value as in HRMS. Unset = the feature is off (`/api/auth/hrms-sso` answers 503). Never commit it |
| `HRMS_URL` | the HRMS web app, for **Back to HRMS** and the login redirect |
| `HRMS_API_URL` | the HRMS API, server to server (defaults to `TEAMLINK_API_URL`) |
| `HRMS_SSO_IDLE_MINUTES` | 30; keep it equal to HRMS `SESSION_IDLE_MINUTES` |
| `HRMS_SSO_CHECK_SECONDS` | 60; how often the portal re-asks HRMS |
| `HRMS_SSO_STAFF_REDIRECT` | 1; 0 = signed-out staff deep links go to the portal login |

HRMS (`backend/.env`): `HRMS_SSO_SECRET` and `SESSION_IDLE_MINUTES`. It also
needs `JOB_PORTAL_PUBLIC_URL` when the portal is not embedded at `/jobs`, and
`JOB_PORTAL_API_URL` when the portal is not on the embedded internal port.
The embedded portal receives `HRMS_SSO_SECRET`, `HRMS_URL`, `HRMS_API_URL` and
the idle minutes from HRMS automatically (`utils/jobPortalEmbed.js`).

## Files

- Portal:
  - `supabase/migrations/0127_hrms_sso.sql`
  - `api/src/sso/hrms.js`
  - `api/src/routes/hrms-sso.js`
  - `web/hrms-sso.html`
  - `web/teamlink-hrms-sso.js`
  - `api/test/hrms-sso.test.mjs` (17 tests)
- HRMS (TeamLink.Enterprise):
  - `backend/src/utils/jobPortalSso.js`
  - `backend/src/utils/authSessions.js`
  - `backend/src/routes/sso.js`
  - the `AuthSession` model and migration `20261009150000_auth_sessions`
  - `frontend/src/pages/JobPortalLaunch.jsx`
  - the sidebar item in `Shell.jsx`
  - `backend/scripts/test-job-portal-sso.js`
