# Prototype baseline — teamlink-job-portal-updated_16.html

Captured before any backend work. Re-run this sweep after every change; any
deviation is a regression.

- Source: `C:\Users\user\Downloads\teamlink-job-portal-updated_16.html`
- Size: 1,587,110 bytes / 22,935 lines
- Inline `<script>` blocks: 117 — all pass `node --check`
- Functions: 691 · `window.*` exports: 620 · page renderers: 19
- Served from `baseline/prototype.html` on :4321 for verification

## Routes verified rendering with ZERO console errors (40)

Public (11): / · /jobs · /job/j1 · /company/technova · /login/{candidate,
recruiter,client,admin} · /register/candidate · /ai-pipeline · /whatsapp-demo

Candidate (8): home profile applications saved alerts interviews messages settings
Recruiter (9): home copilot jobs candidates pipeline interviews find comm settings
Client (4): jobs candidates interviews offers
Admin (8): users jobs candidates applications interviews settings recruiters notifications

## Seed data counts (must match after migration)

companies 3 · jobs 13 · recruiters 3 · clients 3 · candidates 10 · interviews 7
· stages 9 · applications 0 at boot (rehydrated from localStorage)

## ATS stages (exact ids — do not rename)

applied · ai_screening · shortlisted · interview_scheduled · ai_interview_done
· client_review · offer_extended · selected · rejected
