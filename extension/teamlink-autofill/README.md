# TeamLink AutoFill

A Chrome/Edge extension (Manifest V3) that fills external job application
forms from the candidate's existing TeamLink profile.

**It never submits anything.** There is no code path that clicks a button
on the employer's page. The candidate reviews the form and submits it.

---

## Install (unpacked)

1. `chrome://extensions` → Developer mode on → **Load unpacked** → choose
   this folder.
2. Copy the extension id Chrome shows.
3. In the TeamLink server's `.env`, add that id as an allowed origin:

   ```
   EXTRA_ORIGINS=chrome-extension://<the id you copied>
   ```

   Restart the server. This is only needed for the *tracking* call
   (section 4). Signing in and filling forms work without it.
4. Click the extension icon, set the TeamLink address, sign in with the
   candidate's own account.

---

## What is stored

| | |
|---|---|
| Password | **Never.** Used for one request, then gone. |
| Session | The browser's own httpOnly cookie. The extension cannot read it. |
| Profile | Cached in `chrome.storage.local` for 1 hour. "Refresh profile" re-reads it. |
| Per-site auto-fill | A list of hostnames the candidate opted in for. |

Sign out clears all of it. Nothing else is kept.

### A deviation from the brief, stated plainly

The brief asked for "a short-lived token in `chrome.storage.local`". The
TeamLink API does not issue one — it authenticates with an httpOnly
session cookie plus a CSRF double-submit, and there is no bearer path.
Adding one would mean a second authentication surface on a product that
already has a working one. So the extension signs in through the same
endpoint a browser uses and lets the browser hold the cookie. **Nothing
resembling a credential is stored by the extension at all**, which is
stricter than the brief asked for.

---

## Permissions, and why each one

- `activeTab`, `storage` — as specified.
- `cookies` — to read `tl_csrf`, which the API requires on writes and
  which it sets as a readable cookie by design. Scoped to the hosts
  below; the extension cannot read cookies for any other site.
- `host_permissions` — the four ATS domains and the TeamLink origin.
  **Not `<all_urls>`.**

---

## What gets filled

Matching runs over each input's label, `aria-label`, `aria-labelledby`,
placeholder, `name` and `id` against a synonym dictionary
(`content/fields.js`). Values are written through the native property
setter and followed by `input`/`change`/`blur` events, which is what
makes React- and Angular-based forms register the change instead of
reverting it on the next render.

**Anything that cannot be matched confidently is left blank** and listed
in the summary for the candidate to complete.

### Never filled, under any circumstance

`content/fields.js` → `neverFill()`, checked *before* any matching and
again immediately before any write:

- passwords, PINs, OTPs, security codes, API keys
- card numbers, CVV, expiry, IBAN, SWIFT, sort code, bank account,
  routing number
- SSN, national insurance, Aadhaar, PAN, passport, driving licence,
  tax id, visa/permit number
- date of birth
- every `<input type=file>`, `type=password` and `type=hidden`

Measured against a fixture carrying all of these: **8 of 8 blocked**,
each returning `neverFill: true` and no match.

---

## Coverage

| Platform | Adapter | Coverage | Notes |
|---|---|---|---|
| Lever | `lever.js` | **Good** | Stable `name` attributes (`name`, `email`, `phone`, `org`, `urls[LinkedIn]`). 5/5 in test. |
| Greenhouse | `greenhouse.js` | **Good** | Stable ids (`job_application[first_name]`…). 10/10 fillable in test, 8 traps refused. |
| Workday | `workday.js` | **Partial** | Matches by `data-automation-id`, the only stable hook. 4/4 fillable in test. Country and phone-code are custom listboxes, not `<select>`, and are **not** filled; an application spans several steps and only the visible one is touched. |
| iCIMS | `icims.js` | **Poor** | Numeric per-tenant field names (`field_1234`) and often an iframe on the employer's own domain. Falls back entirely to label matching. |
| Anything else | `generic.js` | **Varies** | Pure label matching. Runs only where three or more fields match, so it does nothing on a jobs list or a marketing page. |

**To improve Workday and iCIMS** a per-tenant field map is needed, built
by visiting a tenant and recording its ids. That is real work, not a
line of code, and it has not been done.

---

## Tracking

When the page URL matches the `applyUrl` of a job TeamLink already holds,
one event is posted to `POST /api/external/apply` and the application is
recorded as **Clicked** — the same word the portal uses when a candidate
opens an employer's link from the site.

It never records "Applied" or "Submitted". Nothing in a browser can know
whether an employer's form was actually submitted, and the candidate
confirms it in TeamLink as they always have. If the URL matches no job on
record, nothing is posted and the candidate logs it from the site.

Only the page address leaves the tab. **No form content is ever sent
anywhere** — not to TeamLink, not to anyone.

---

## Resume attachment

A browser will not let a script choose a file. The summary says so and
points at the form's own file button. This is a browser rule, not a gap.
