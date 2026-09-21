# UI fidelity — how "visually identical" is proved

The frontend must not change. This is the mechanism that holds me to it,
so the claim rests on a check anyone can re-run rather than on my word.

```bash
npm run ui:capture current      # record the app as it stands now
npm run ui:compare baseline current
```

Exit code 0 means unchanged. Non-zero prints every screen that moved and why.

## What is recorded

80 screens — **40 routes × 2 viewports** (desktop 1440×900, mobile 390×844) —
covering every screen named in the requirements:

| Area | Screens |
|---|---|
| Public | home, jobs search, job detail, company, 4 login screens, register, AI pipeline, WhatsApp demo |
| Candidate | home, profile, applications, saved, alerts, interviews, messages, settings |
| Recruiter | home, copilot, jobs, candidates, pipeline, interviews, find, comm, settings |
| Client | jobs, candidates, interviews, offers |
| Admin | users, jobs, candidates, applications, interviews, recruiters, notifications, settings |

For each screen:

1. **PNG screenshot** — `ui-snapshots/<label>/<viewport>/<screen>.png`
2. **Structural fingerprint** — the DOM skeleton with all text and data values
   stripped, leaving tags, classes, and layout attributes
3. **Computed styles** — colour, background, font family/size/weight,
   line-height, letter-spacing, padding, margin, border, border-radius,
   box-shadow, display, flex/grid properties, gap, text-transform, opacity,
   sampled across up to 400 distinct class combinations per screen
4. **`:root` design tokens** — all 51 of them, resolved
5. **Navigation order** — header, sidebar and tab labels in DOM order
6. **Horizontal overflow** — the classic mobile regression

## Why not just compare pixels

Once the app reads from Postgres the *values* on screen legitimately change:
a real applied date instead of `"2 days ago"`, a real applicant count instead
of a drifting counter. A pixel diff flags all of that, and the real signal
drowns. The fingerprint ignores values and captures only what must not move.

## Two kinds of variance are ignored, deliberately

Both were found by running the **unmodified** prototype twice and diffing it
against itself:

- **Sibling order.** `candidate-home` renders its recommended job cards in a
  different order on each load. The structural hash sorts sibling subtrees, so
  reordering is reported as a note rather than a failure. Navigation order is
  checked separately and exactly, because the requirements call it out.
- **Sub-pixel jitter.** Font metrics produce fractional pixel widths that vary
  run to run. `width` and `height` are excluded entirely (they are derived from
  content), and remaining px values are rounded to 0.5px.

## The harness is calibrated, not assumed

A check that cannot fail proves nothing, so it was tested in both directions:

| Test | Expected | Result |
|---|---|---|
| Prototype vs itself, two separate runs | no change | **80/80 identical** |
| Prototype vs a 1-colour + 1-radius edit | caught | **0/80 identical, 74 screens flagged** |

The tamper test changed `--brand-600` by five hex digits (`#4f46e5` →
`#4f46f0`) and `--radius-m` by 2px. Both were detected on every affected
screen.

## A finding from calibrating it

The first tamper attempt edited `--brand-600:#0b6e8f` at line 27 and the
harness correctly reported **no change** — because the prototype declares its
design tokens **twice**:

```
line  27:  --brand-600:#0b6e8f    (teal)    ← dead, overridden
line 754:  --brand-600:#4f46e5    (indigo)  ← the one that renders
line  58:  --radius-m:10px                  ← dead, overridden
line 767:  --radius-m:12px                  ← the one that renders
```

The whole token block near the top of the file is shadowed by a later theme
override. **The live palette is indigo, not the teal the file opens with.**
Worth knowing before anyone edits the top block expecting a visible effect.

## Baseline provenance

`baseline/prototype.html` is byte-identical to the supplied file:

```
SHA-256  8CC4B430D496694618D72A51CE0A7CD11FE567701D3544AC852D38186EFC0862
```

It is never edited. Integration work happens on a separate copy, and the
comparison above is what licenses shipping it.
