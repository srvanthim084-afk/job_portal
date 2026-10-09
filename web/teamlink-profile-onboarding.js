/* =====================================================================
   TEAMLINK - "Build your profile" (0124)

   WHO SEES IT. A candidate who has just registered, and one added from
   the Talent Pool who has signed in and chosen a password. Both arrive at
   a profile that is mostly empty; this walks them through filling it.

   THE PROMPT. "Build your profile to get better job matches."  OK starts
   the wizard; Later closes it. Later is remembered on the server
   (candidates.onboarding_status = skipped) and from then on the candidate
   sees a quiet "Complete your profile" banner with their completion %
   instead of a box in front of the page. A finished profile is never
   asked about again.

   FIVE STEPS, with Back, Save and Continue, and a "Step X of 5" bar:

     1  Resume          upload, Replace, Remove - or Skip and type it
     2  Reading         what the resume said, in counts
     3  Review          every section an editable card; "Needs review"
                        on what the reader was unsure of or did not find;
                        Key skills in a card of their own
     4  Details         the six things a resume cannot tell us. Only the
                        ones not already on the record are asked
     5  Profile ready   saved in one transaction, then straight to Home

   NOTHING IS SAVED BEFORE THE CANDIDATE CONFIRMS. Uploading keeps the file
   and READS it; the reading is only shown. The profile columns change at
   the end (POST /onboarding/complete), in one transaction, and a retry
   makes no second copy of anything. What they have typed so far is kept
   on the server as a draft, so a refresh - or another device - reopens
   the wizard on the same step with the same edits.

   NEVER INVENTED, NEVER OVERWRITTEN. A field the resume does not contain
   stays blank. A value the candidate already has (from registration, or
   typed here) is not replaced by the reading; lists are added to, not
   substituted, and read twice give each entry once.

   ADDITIVE. One overlay appended to <body>, one wrapped render(). No
   existing screen is replaced.
   ===================================================================== */
(function () {
  'use strict';

  function api() { return (window.TL && window.TL.api) || null; }
  function esc(s) {
    return (typeof window.esc === 'function') ? window.esc(s)
      : String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
  }
  function toast(m, i) { if (typeof window.toast === 'function') window.toast(m, i || 'ℹ️'); }
  function blank(v) {
    if (v === undefined || v === null) return true;
    if (Array.isArray(v)) return v.length === 0;
    return String(v).trim() === '';
  }

  var MAX_RESUME_BYTES = 5 * 1024 * 1024;
  var ACCEPT = ['pdf', 'doc', 'docx'];
  var HOME = '/candidate/home';

  /* Built enough to stop asking: a CV on file and most of the profile
     filled in. Not 100% - the last few fields are optional by nature. */
  var BUILT_AT = 70;

  var NOTICE = ['Immediate', '15 days', '30 days', '60 days', '90 days', 'Other'];
  /* The stored values the matcher already reads. */
  var MODES = [['Office', 'Work from Office'], ['Hybrid', 'Hybrid'], ['Remote', 'Remote / Work from Home']];
  var STEPS = ['Your resume', 'Reading your resume', 'Review your profile', 'A few more details', 'Profile ready'];
  var LAST = STEPS.length - 1;

  var S = {
    mode: null,          // null | 'modal' | 'wizard'
    step: 0,
    loading: false,      // fetching the saved draft
    saving: false,       // an upload / read / save is in flight
    error: '',
    fieldErr: {},
    resumeName: '',
    parseState: '',      // '' | 'uploading' | 'reading' | 'done' | 'failed'
    parse: null,         // { ok, counts } - a summary of what was read, not the reading itself
    flags: {},           // section -> "Needs review"
    touched: {},         // section -> the candidate has looked at / edited it
    bannerHidden: false,
    askedThisVisit: false,
    /* The record as it was when the wizard opened: what is "already collected". */
    before: null,
    form: null,
    formFor: null,
    local: {},           // candidate id -> status, once this page has changed it
    persistT: null,
    doneInfo: null,
  };

  /* ------------------------------------------------------------------ *
   * who we are talking to
   * ------------------------------------------------------------------ */
  function me() {
    if (!window.STATE || !STATE.session || STATE.session.role !== 'candidate') return null;
    if (STATE.session.mustChangePassword) return null;   // one ask at a time
    try { return DATA.candidateById(STATE.session.id) || null; } catch (e) { return null; }
  }
  function completion(c) {
    return (typeof window.capCompletion === 'function') ? window.capCompletion(c) : 0;
  }
  function built(c) {
    return !!(c && c.resumeFile) && completion(c) >= BUILT_AT;
  }
  function statusOf(c) {
    return (c && S.local[c.id]) || (c && c.onboardingStatus) || 'not_started';
  }
  function setStatus(c, status) {
    if (!c) return;
    S.local[c.id] = status;
    try { c.onboardingStatus = status; } catch (e) { /* the next bootstrap carries it */ }
  }

  /* ------------------------------------------------------------------ *
   * the ring
   * ------------------------------------------------------------------ */
  function ring(pct, size) {
    var r = (size / 2) - 5;
    var circ = 2 * Math.PI * r;
    var on = circ * (Math.max(0, Math.min(100, pct)) / 100);
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '" '
      + 'style="flex:0 0 auto" aria-hidden="true">'
      + '<circle cx="' + (size / 2) + '" cy="' + (size / 2) + '" r="' + r + '" fill="none" '
        + 'stroke="#e4ecf4" stroke-width="7"></circle>'
      + '<circle cx="' + (size / 2) + '" cy="' + (size / 2) + '" r="' + r + '" fill="none" '
        + 'stroke="#1490b3" stroke-width="7" stroke-linecap="round" '
        + 'stroke-dasharray="' + on.toFixed(1) + ' ' + circ.toFixed(1) + '" '
        + 'transform="rotate(-90 ' + (size / 2) + ' ' + (size / 2) + ')"></circle>'
      + '<text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" '
        + 'font-size="' + Math.round(size / 3.6) + '" font-weight="800" fill="#123">'
        + pct + '%</text></svg>';
  }

  /* ------------------------------------------------------------------ *
   * the working copy
   *
   * Everything the candidate has touched lives here until Finish, so a
   * failed save loses nothing and Back keeps their edits. It is seeded
   * from the record, so what registration already collected is on screen
   * and is not asked again.
   * ------------------------------------------------------------------ */
  function blankForm(c) {
    var exp = (c.experienceRecords || []).map(function (x) {
      return {
        company: x.company || '', jobTitle: x.jobTitle || '',
        location: x.location || '', employmentType: x.employmentType || '',
        responsibilities: x.responsibilities || '',
      };
    });
    /* The simplified registration keeps "most recent role / company" as two columns, not as a job row.
       Shown as the first job so it is on screen, editable, and saved as a row. */
    if (!exp.length && (c.title || c.currentCompany)) {
      exp.push({ company: c.currentCompany || '', jobTitle: c.title || '', location: '',
                 employmentType: '', responsibilities: '' });
    }
    return {
      name: c.name || '', email: c.email || '', phone: c.phone || '',
      summary: c.summary || '',
      title: c.title || '', currentCompany: c.currentCompany || '',
      expYears: (c.expYears === undefined || c.expYears === null) ? '' : String(c.expYears),
      skills: (c.skills || []).slice(),
      certifications: (c.certifications || []).slice(),
      languages: (c.languages || []).slice(),
      projects: (c.projects || []).map(function (p) {
        return typeof p === 'string' ? { name: p, description: '' } : {
          name: p.name || '', description: p.desc || p.description || '',
        };
      }),
      /* SEEDED FROM WHAT IS SAVED. Finish REPLACES both lists with this one, because the candidate is
         looking at the whole list when they confirm. A wizard that opened with these empty would delete
         the jobs and qualifications they had entered earlier. */
      experience: exp,
      education: (c.educationRecords || []).map(function (e) {
        return {
          qualification: e.qualification || '', specialization: e.specialization || '',
          institution: e.institution || '',
          passingYear: e.passingYear == null ? '' : String(e.passingYear),
          score: e.score || '', educationType: e.educationType || '',
        };
      }),
      /* Step 4. From what the record already holds - never from the resume. */
      noticePeriod: String(c.noticePeriod || ''),
      currentLocation: c.location || '',
      preferredLocations: c.preferredLocation
        ? String(c.preferredLocation).split(',').map(function (x) { return x.trim(); }).filter(Boolean) : [],
      preferredRoles: c.preferredRole
        ? String(c.preferredRole).split(',').map(function (x) { return x.trim(); }).filter(Boolean) : [],
      workModes: (c.preferredWorkModes || []).slice(),
      /* Stored in lakh per annum. */
      salaryAmount: c.expectedCtc ? String(c.expectedCtc) : '',
      salaryUnit: 'year',
    };
  }

  /* What registration (or an earlier visit) already collected: not asked again. */
  function have() {
    var b = S.before || {};
    return {
      location: !blank(b.location),
      preferredLocation: !blank(b.preferredLocation),
      noticePeriod: !blank(b.noticePeriod),
      expectedCtc: Number(b.expectedCtc) > 0,
      preferredRole: !blank(b.preferredRole),
      workModes: !blank(b.preferredWorkModes),
    };
  }

  /** What the reader found, folded into the working copy.
      Never overwrites what is already there; never invents. Returns the counts shown on step 2. */
  function adoptParse(parse) {
    var f = S.form;
    var fields = (parse && parse.fields) || {};
    var fillIfEmpty = function (key, v) {
      if (blank(v) || !blank(f[key])) return;
      f[key] = (typeof v === 'number') ? String(v) : String(v).trim();
    };
    fillIfEmpty('name', fields.name);
    fillIfEmpty('phone', fields.phone);
    fillIfEmpty('summary', fields.summary);
    fillIfEmpty('title', fields.title);
    fillIfEmpty('currentCompany', fields.currentCompany);
    fillIfEmpty('expYears', fields.expYears);
    /* NOT the city: where they live is asked on step 4, from them. */

    var mergeList = function (key, incoming) {
      var seen = {};
      f[key].forEach(function (x) { seen[String(x).trim().toLowerCase()] = true; });
      (incoming || []).forEach(function (x) {
        var k = String(x || '').trim().toLowerCase();
        if (!k || seen[k]) return;
        seen[k] = true; f[key].push(String(x).trim());
      });
    };
    mergeList('skills', fields.skills);
    mergeList('certifications', fields.certifications);
    mergeList('languages', fields.languages);

    var mergeRows = function (kind, incoming, keyOf) {
      var seen = {};
      f[kind].forEach(function (r) { seen[keyOf(r)] = true; });
      incoming.forEach(function (r) {
        var k = keyOf(r);
        if (k === '|' || seen[k]) return;
        seen[k] = true; f[kind].push(r);
      });
    };

    /* a project is "Name - what it was" on one line; split it, so the name is a name */
    var projSeen = {};
    f.projects.forEach(function (p) { projSeen[String(p.name || '').trim().toLowerCase()] = true; });
    (fields.projects || []).forEach(function (line) {
      var m = /^(.{2,120}?)\s+[-–—:|]\s+(.+)$/.exec(String(line || ''));
      var name = (m ? m[1] : String(line || '')).trim();
      var k = name.toLowerCase();
      if (!name || projSeen[k]) return;
      projSeen[k] = true;
      f.projects.push({ name: name, description: m ? m[2].trim() : '' });
    });

    var jobKey = function (r) {
      return String(r.company || '').trim().toLowerCase() + '|' + String(r.jobTitle || '').trim().toLowerCase();
    };
    var jobs = (fields.employmentHistory || []).map(function (e) {
      return { company: e.company || '', jobTitle: e.title || '', location: '',
               employmentType: String(e.period || '').slice(0, 40), responsibilities: e.details || '' };
    });
    if (!jobs.length && (fields.currentCompany || fields.title)) {
      jobs = [{ company: fields.currentCompany || '', jobTitle: fields.title || '', location: '',
                employmentType: '', responsibilities: '' }];
    }
    mergeRows('experience', jobs, jobKey);

    var eduKey = function (r) {
      return String(r.qualification || '').trim().toLowerCase() + '|' + String(r.institution || '').trim().toLowerCase();
    };
    var edu = (fields.educationRecords || []).map(function (e) {
      return { qualification: e.qualification || e.level || '', specialization: e.specialization || '',
               institution: e.institution || '', passingYear: e.passingYear == null ? '' : String(e.passingYear),
               score: e.score || '', educationType: e.educationType || e.level || '' };
    });
    if (!edu.length && fields.qualification) {
      edu = [{ qualification: fields.qualification, specialization: '', institution: '', passingYear: '', score: '', educationType: '' }];
    }
    mergeRows('education', edu, eduKey);

    /* what to look at again: what the reader was unsure of, and the sections it found nothing for */
    var unsure = {};
    (parse.needsVerification || []).forEach(function (k) { unsure[k] = true; });
    S.flags = {};
    if (unsure.name || unsure.phone || unsure.email || blank(f.name) || blank(f.phone)) S.flags.personal = true;
    if (unsure.title || unsure.currentCompany || unsure.expYears || unsure.employmentHistory || !f.experience.length) S.flags.work = true;
    if (unsure.educationRecords || unsure.qualification || unsure.education || !f.education.length) S.flags.education = true;
    if (unsure.skills || !f.skills.length) S.flags.skills = true;
    if (unsure.projects) S.flags.projects = true;
    if (unsure.certifications) S.flags.certifications = true;
    if (unsure.summary) S.flags.summary = true;
    if (unsure.languages) S.flags.languages = true;
    S.touched = {};

    return {
      skills: f.skills.length, jobs: f.experience.length, education: f.education.length,
      projects: f.projects.length, certifications: f.certifications.length, languages: f.languages.length,
    };
  }

  /* ------------------------------------------------------------------ *
   * painting
   * ------------------------------------------------------------------ */
  function host() {
    var el = document.getElementById('tlpoHost');
    if (!el) {
      el = document.createElement('div');
      el.id = 'tlpoHost';
      document.body.appendChild(el);
    }
    return el;
  }

  function paint() {
    var el = host();
    var c = me();
    if (!c || !S.mode) { el.innerHTML = ''; return; }
    var prev = document.getElementById('tlpoBody');
    var keep = prev && S.paintedStep === S.step ? prev.scrollTop : 0;
    el.innerHTML = S.mode === 'modal' ? modalHtml(c) : wizardHtml(c);
    S.paintedStep = S.step;
    var nb = document.getElementById('tlpoBody');
    if (nb && keep) nb.scrollTop = keep;
    var t = document.getElementById('tlpoTitle');
    if (t && S.mode === 'wizard' && S.focusTitle) { S.focusTitle = false; try { t.focus(); } catch (e) { /* nothing */ } }
  }

  function modalHtml(c) {
    return '<div class="tlpo-ov" onclick="tlpoBackdrop(event)">'
      + '<div class="tlpo-card tlpo-modal" role="dialog" aria-modal="true" aria-labelledby="tlpoTitle">'
      +   '<div class="tlpo-modal-top">'
      +     ring(completion(c), 76)
      +     '<div><h2 id="tlpoTitle">Build your profile</h2>'
      +       '<p>Build your profile to get better job matches.</p></div>'
      +   '</div>'
      +   '<div class="tlpo-acts">'
      +     '<button class="tlpo-btn ghost" onclick="tlpoLater()">Later</button>'
      +     '<button class="tlpo-btn pri" onclick="tlpoStart()">OK</button>'
      +   '</div>'
      + '</div></div>';
  }

  /* ---- small pieces ------------------------------------------------- */
  function field(label, inner, hint, id, err) {
    return '<div class="tlpo-f' + (err ? ' bad' : '') + '"><label class="tlpo-l"' + (id ? ' for="' + id + '"' : '') + '>' + esc(label) + '</label>'
      + inner + (hint ? '<span class="tlpo-hint">' + esc(hint) + '</span>' : '')
      + (err ? '<span class="tlpo-ferr" role="alert">' + esc(err) + '</span>' : '') + '</div>';
  }

  function chips(kind, list, placeholder, label) {
    return '<div class="tlpo-chips" id="tlpoChips_' + kind + '" data-ph="' + esc(placeholder) + '" data-lab="' + esc(label || placeholder) + '">'
      + list.map(function (v, i) {
          return '<span class="tlpo-chip">' + esc(v)
            + '<button type="button" aria-label="Remove ' + esc(v) + '" '
            + 'onclick="tlpoChipRemove(\'' + kind + '\',' + i + ')">✕</button></span>';
        }).join('')
      + '<input class="tlpo-chipin" id="tlpoChipIn_' + kind + '" placeholder="'
      + esc(placeholder) + '" aria-label="' + esc(label || placeholder) + '" autocomplete="off" '
      + 'onkeydown="tlpoChipKey(event,\'' + kind + '\')" onblur="tlpoChipAdd(\'' + kind + '\',true)">'
      + '</div>';
  }

  function rowsBlock(kind, rows, cols, noun) {
    return '<div class="tlpo-rows">'
      + rows.map(function (r, i) {
          return '<div class="tlpo-row">'
            + '<button class="tlpo-rowx" type="button" aria-label="Remove this ' + esc(noun) + '" '
            +   'onclick="tlpoRowRemove(\'' + kind + '\',' + i + ')">✕</button>'
            + cols.map(function (col) {
                var v = r[col[0]] == null ? '' : r[col[0]];
                var id = 'tlpoR_' + kind + '_' + i + '_' + col[0];
                return '<div class="tlpo-f' + (col[2] === 'wide' ? ' wide' : '') + '">'
                  + '<label class="tlpo-l" for="' + id + '">' + esc(col[1]) + '</label>'
                  + (col[2] === 'wide'
                    ? '<textarea class="tlpo-i tlpo-ta" id="' + id + '" rows="2" '
                      + 'oninput="tlpoRowSet(\'' + kind + '\',' + i + ',\'' + col[0] + '\',this.value)">'
                      + esc(v) + '</textarea>'
                    : '<input class="tlpo-i" id="' + id + '" value="' + esc(v) + '" '
                      + 'oninput="tlpoRowSet(\'' + kind + '\',' + i + ',\'' + col[0] + '\',this.value)">')
                  + '</div>';
              }).join('')
            + '</div>';
        }).join('')
      + '<button class="tlpo-add" type="button" onclick="tlpoRowAdd(\'' + kind + '\')">'
      + '+ ' + esc((rows.length ? 'Add another ' : 'Add a ') + noun) + '</button></div>';
  }

  /* a review card: a title, a "Needs review" flag until the candidate has looked at it */
  function card(sec, title, inner, extra) {
    var flagged = S.flags[sec] && !S.touched[sec];
    return '<section class="tlpo-sec' + (extra ? ' ' + extra : '') + (flagged ? ' flag' : '') + '" id="tlpoSec_' + sec + '">'
      + '<div class="tlpo-sec-h"><h3 class="tlpo-h">' + esc(title) + '</h3>'
      + (flagged ? '<span class="tlpo-pill" id="tlpoPill_' + sec + '">Needs review</span>' : '') + '</div>'
      + inner + '</section>';
  }

  /* ---- step 1: the resume ---------------------------------------------- */
  function stepResume(c) {
    var busy = S.parseState === 'uploading' || S.parseState === 'reading';
    var onFile = c.resumeFile || '';
    var picker = '<input type="file" id="tlpoFile" accept=".pdf,.doc,.docx" style="display:none" '
      + 'aria-label="Resume file" onchange="tlpoPicked(this)">';
    if (onFile && !busy) {
      return '<div class="tlpo-onfile">'
        + '<div class="tlpo-file-ic" aria-hidden="true">📄</div>'
        + '<div class="tlpo-file-t"><b>' + esc(onFile) + '</b><span>This is the resume on your profile.</span></div>'
        + '<div class="tlpo-file-a">'
        +   '<button class="tlpo-btn ghost sm" type="button" onclick="document.getElementById(\'tlpoFile\').click()">Replace</button>'
        +   '<button class="tlpo-btn ghost sm" type="button" onclick="tlpoRemoveResume()">Remove</button>'
        + '</div>' + picker + '</div>'
        + '<div class="tlpo-note">Continue and we will read it to fill in the next step - nothing is saved to your '
        + 'profile until you confirm it. Or replace it with a newer one.</div>';
    }
    return '<div class="tlpo-drop" id="tlpoDrop" ondragover="tlpoDrag(event,1)" ondragleave="tlpoDrag(event,0)" ondrop="tlpoDrop(event)">'
      +   '<div class="tlpo-drop-ic">📄</div>'
      +   '<b>' + (busy ? (S.parseState === 'uploading' ? 'Uploading ' : 'Reading ') + esc(S.resumeName || 'your resume') + '…' : 'Drop your resume here') + '</b>'
      +   '<span>PDF, DOC or DOCX · up to 5 MB</span>'
      +   picker
      +   (busy ? '' : '<button class="tlpo-btn ghost sm" type="button" onclick="document.getElementById(\'tlpoFile\').click()">Browse</button>')
      +   (S.resumeName && !busy ? '<div class="tlpo-file">' + esc(S.resumeName) + '</div>' : '')
      + '</div>'
      + (busy ? '<div class="tlpo-bar"><i></i></div>' : '')
      + '<div class="tlpo-note">We read it to fill in your profile. Anything it gets wrong, you can change on the '
      + 'review step - and you can skip this and type it all in.</div>';
  }

  /* ---- step 2: what was read ------------------------------------------- */
  function stepReading() {
    var p = S.parse;
    if (S.parseState === 'uploading' || S.parseState === 'reading' || S.loading) {
      return '<div class="tlpo-reading" role="status" aria-live="polite"><div class="tlpo-spin" aria-hidden="true"></div>'
        + '<b>Reading your resume…</b><span>This takes a few seconds. Your resume is already saved.</span></div>'
        + '<div class="tlpo-bar"><i></i></div>';
    }
    if (S.parseState === 'failed' || (p && !p.ok)) {
      return '<div class="tlpo-err" role="alert">We could not read that file. You can fill in the details yourself on '
        + 'the next step, or choose another file.</div>'
        + '<div class="tlpo-acts" style="padding:0"><button class="tlpo-btn ghost" onclick="tlpoStart(0)">Choose another file</button></div>';
    }
    if (!p) {
      return '<div class="tlpo-note">No resume was read - you will type your details on the next step.</div>';
    }
    var rows = [
      ['Key skills', p.counts.skills], ['Work experience', p.counts.jobs], ['Education', p.counts.education],
      ['Projects', p.counts.projects], ['Certifications', p.counts.certifications], ['Languages', p.counts.languages],
    ];
    var any = rows.some(function (r) { return r[1] > 0; });
    return '<div class="tlpo-ok" role="status"><b>' + (any ? 'We read your resume' : 'We could not find much in that file') + '</b>'
      + (S.resumeName ? '<span>' + esc(S.resumeName) + '</span>' : '') + '</div>'
      + '<div class="tlpo-counts">' + rows.map(function (r) {
          return '<div class="tlpo-count' + (r[1] ? '' : ' zero') + '"><b>' + r[1] + '</b><span>' + esc(r[0]) + '</span></div>';
        }).join('') + '</div>'
      + '<div class="tlpo-note">' + (any
        ? 'Next you can check every section and change anything. Sections we were unsure of, or found nothing for, are marked "Needs review".'
        : 'Nothing was filled in for you - you can type your details on the next step.') + '</div>';
  }

  /* ---- step 3: review -------------------------------------------------- */
  function stepReview() {
    var f = S.form;
    var note = S.parse && S.parse.ok
      ? 'Check each section and change anything that is wrong. Nothing is saved to your profile until you finish.'
      : 'Fill in what you can. Nothing here is saved until you finish, and you can come back to it later.';
    return '<div class="tlpo-note tlpo-picked">' + esc(note) + '</div>'

      + card('skills', 'Key skills',
          chips('skills', f.skills, 'Type a skill and press Enter', 'Add a key skill')
          + '<span class="tlpo-hint">Each skill once. Click ✕ to remove one.</span>', 'key')

      + card('personal', 'Personal information',
          '<div class="tlpo-grid">'
          + field('Full name', '<input class="tlpo-i" id="tlpoName" value="' + esc(f.name) + '" autocomplete="name" oninput="tlpoSet(\'name\',this.value)">', '', 'tlpoName', S.fieldErr.name)
          + field('Phone', '<input class="tlpo-i" id="tlpoPhone" value="' + esc(f.phone) + '" inputmode="tel" autocomplete="tel" oninput="tlpoSet(\'phone\',this.value)">', '', 'tlpoPhone', S.fieldErr.phone)
          + field('Email', '<input class="tlpo-i" id="tlpoEmail" value="' + esc(f.email) + '" readonly>', 'This is your sign-in address.', 'tlpoEmail')
          + '</div>')

      + card('summary', 'Profile summary',
          '<textarea class="tlpo-i tlpo-ta" id="tlpoSummary" rows="4" aria-label="Profile summary" '
          + 'oninput="tlpoSet(\'summary\',this.value)">' + esc(f.summary) + '</textarea>')

      + card('work', 'Work experience',
          '<div class="tlpo-grid">'
          + field('Most recent role', '<input class="tlpo-i" id="tlpoTitle2" value="' + esc(f.title) + '" oninput="tlpoSet(\'title\',this.value)">', '', 'tlpoTitle2')
          + field('Most recent company', '<input class="tlpo-i" id="tlpoCompany" value="' + esc(f.currentCompany) + '" oninput="tlpoSet(\'currentCompany\',this.value)">', '', 'tlpoCompany')
          + field('Total experience (years)', '<input class="tlpo-i" id="tlpoYears" type="number" min="0" max="60" step="0.5" value="' + esc(f.expYears) + '" oninput="tlpoSet(\'expYears\',this.value)">', '', 'tlpoYears')
          + '</div>'
          + rowsBlock('experience', f.experience, [
              ['company', 'Company'], ['jobTitle', 'Role'],
              ['employmentType', 'Duration'], ['location', 'Location'],
              ['responsibilities', 'Responsibilities', 'wide'],
            ], 'job'))

      + card('education', 'Education',
          rowsBlock('education', f.education, [
            ['qualification', 'Qualification'], ['specialization', 'Field of study'],
            ['institution', 'Institution'], ['passingYear', 'Year'],
            ['score', 'Grade / %'],
          ], 'qualification'))

      + card('projects', 'Projects',
          rowsBlock('projects', f.projects, [
            ['name', 'Project'], ['description', 'What it was', 'wide'],
          ], 'project'))

      + card('certifications', 'Certifications',
          chips('certifications', f.certifications, 'Type a certification and press Enter', 'Add a certification'))

      + card('languages', 'Languages',
          chips('languages', f.languages, 'Type a language and press Enter', 'Add a language'));
  }

  /* ---- step 4: the details a resume cannot tell us ---------------------- */
  function stepDetails() {
    var f = S.form, h = have(), e = S.fieldErr;
    var asked = !h.location || !h.preferredLocation || !h.noticePeriod || !h.expectedCtc || !h.preferredRole || !h.workModes;
    var out = '<div class="tlpo-note">' + (asked
      ? 'These decide which jobs you are shown and what a recruiter says on your behalf, so we ask you rather than guess.'
      : 'You have already given us these - nothing more to ask.') + '</div>';

    if (!h.location) {
      out += field('Current location *',
        '<input class="tlpo-i" id="tlpo_curloc" value="' + esc(f.currentLocation) + '" placeholder="e.g. Hyderabad" '
        + 'autocomplete="address-level2" oninput="tlpoSet(\'currentLocation\',this.value)">', '', 'tlpo_curloc', e.location);
    }
    if (!h.preferredLocation) {
      out += field('Preferred locations *', chips('preferredLocations', f.preferredLocations,
        'Type a city and press Enter', 'Add a preferred location'), 'You can add more than one.', 'tlpoChipIn_preferredLocations', e.preferredLocations);
    }
    if (!h.noticePeriod) {
      var opts = NOTICE.slice();
      if (f.noticePeriod && opts.indexOf(f.noticePeriod) < 0) opts.splice(opts.length - 1, 0, f.noticePeriod);
      out += field('Notice period *',
        '<select class="tlpo-i" id="tlpo_notice" onchange="tlpoSet(\'noticePeriod\',this.value)"><option value="">Select…</option>'
        + opts.map(function (n) {
            return '<option value="' + esc(n) + '"' + (f.noticePeriod === n ? ' selected' : '') + '>' + esc(n) + '</option>';
          }).join('') + '</select>', '', 'tlpo_notice', e.noticePeriod);
    }
    if (!h.expectedCtc) {
      out += field('Expected salary *',
        '<div class="tlpo-money"><span class="tlpo-cur">₹</span>'
        + '<input class="tlpo-i" id="tlpo_sal" type="number" min="0" step="0.1" value="' + esc(f.salaryAmount) + '" '
        + 'placeholder="e.g. 4.5" oninput="tlpoSet(\'salaryAmount\',this.value)">'
        + '<select class="tlpo-i tlpo-unit" aria-label="Salary unit" onchange="tlpoSet(\'salaryUnit\',this.value)">'
        + '<option value="year"' + (f.salaryUnit === 'year' ? ' selected' : '') + '>lakh per annum</option>'
        + '<option value="month"' + (f.salaryUnit === 'month' ? ' selected' : '') + '>₹ per month</option>'
        + '</select></div>', '', 'tlpo_sal', e.salary);
    }
    if (!h.preferredRole) {
      out += field('Preferred role *', chips('preferredRoles', f.preferredRoles,
        'Type a role and press Enter', 'Add a preferred role'), '', 'tlpoChipIn_preferredRoles', e.preferredRoles);
    }
    if (!h.workModes) {
      out += field('Preferred work mode *',
        '<div class="tlpo-modes" role="group" aria-label="Preferred work mode">' + MODES.map(function (m) {
          var on = f.workModes.indexOf(m[0]) >= 0;
          return '<label class="tlpo-mode' + (on ? ' on' : '') + '"><input type="checkbox" value="' + m[0] + '"'
            + (on ? ' checked' : '') + ' onchange="tlpoMode(this)"><span>' + esc(m[1]) + '</span></label>';
        }).join('') + '</div>', '', '', e.modes);
    }
    return out;
  }

  /* ---- step 5: saving, then done --------------------------------------- */
  function stepDone(c) {
    if (S.saving) {
      return '<div class="tlpo-reading" role="status" aria-live="polite"><div class="tlpo-spin" aria-hidden="true"></div>'
        + '<b>Saving your profile…</b><span>Just a moment.</span></div>';
    }
    if (S.doneInfo) {
      return '<div class="tlpo-ready" role="status" aria-live="polite">'
        + ring(S.doneInfo.pct, 96)
        + '<h3>Profile ready</h3>'
        + '<p>Your profile is ' + S.doneInfo.pct + '% complete. Taking you to your jobs…</p></div>';
    }
    return '<div class="tlpo-note">Your profile has not been saved yet.</div>';
  }

  function wizardHtml(c) {
    var finishing = S.step === LAST;
    var title = STEPS[S.step];
    var body = S.loading && !S.form ? '<div class="tlpo-reading" role="status"><div class="tlpo-spin" aria-hidden="true"></div><b>Loading…</b></div>'
      : S.step === 0 ? stepResume(c) : S.step === 1 ? stepReading() : S.step === 2 ? stepReview()
      : S.step === 3 ? stepDetails() : stepDone(c);
    var busy = S.saving || S.parseState === 'uploading' || S.parseState === 'reading';
    var primary = S.step === 0 ? 'Continue' : S.step === 1 ? 'Continue' : S.step === 2 ? 'Confirm and continue'
      : S.step === 3 ? 'Save and continue' : (S.error ? 'Try again' : 'Finish');
    var showPrimary = !(finishing && (S.saving || S.doneInfo));
    var canSkip = S.step === 0 && !busy;
    return '<div class="tlpo-ov" onclick="tlpoBackdrop(event)">'
      + '<div class="tlpo-card tlpo-wiz" role="dialog" aria-modal="true" aria-labelledby="tlpoTitle">'
      +   '<div class="tlpo-head">'
      +     '<div><div class="tlpo-step" id="tlpoStepNo">Step ' + (S.step + 1) + ' of ' + STEPS.length + '</div>'
      +       '<h2 id="tlpoTitle" tabindex="-1">' + esc(title) + '</h2></div>'
      +     ring(S.doneInfo ? S.doneInfo.pct : completion(c), 52)
      +     (finishing && (S.saving || S.doneInfo) ? '' : '<button class="tlpo-x" onclick="tlpoClose()" aria-label="Close and finish later">✕</button>')
      +   '</div>'
      +   '<div class="tlpo-dots" role="progressbar" aria-valuemin="1" aria-valuemax="' + STEPS.length + '" aria-valuenow="' + (S.step + 1) + '">'
      +     STEPS.map(function (s, i) {
            return '<i class="' + (i < S.step ? 'done' : i === S.step ? 'on' : '') + '"></i>';
          }).join('')
      +   '</div>'
      +   '<div class="tlpo-body" id="tlpoBody">'
      +     (S.error ? '<div class="tlpo-err" role="alert">' + esc(S.error) + '</div>' : '')
      +     body
      +   '</div>'
      +   (showPrimary
        ? '<div class="tlpo-acts">'
        +     (S.step > 0 && !finishing
              ? '<button class="tlpo-btn ghost" onclick="tlpoBack()"' + (busy ? ' disabled' : '') + '>Back</button>' : '')
        +     (finishing && S.error ? '<button class="tlpo-btn ghost" onclick="tlpoBack()">Back</button>' : '')
        +     (canSkip ? '<button class="tlpo-skip" onclick="tlpoSkipResume()">Skip - I will type it in</button>' : '')
        +     '<button class="tlpo-btn pri" onclick="tlpoNext()"' + (busy || (S.step === 1 && S.loading) ? ' disabled' : '') + '>'
        +       (busy ? 'Please wait…' : primary) + '</button>'
        +   '</div>'
        : '')
      +   '<div class="tlpo-foot">' + (S.doneInfo ? '' : 'Your progress is saved - close this and pick up where you left off.') + '</div>'
      + '</div></div>';
  }

  /* ------------------------------------------------------------------ *
   * editing
   * ------------------------------------------------------------------ */
  var KEY_SECTION = { name: 'personal', phone: 'personal', summary: 'summary', title: 'work', currentCompany: 'work', expYears: 'work' };
  var KIND_SECTION = { experience: 'work', education: 'education', projects: 'projects', skills: 'skills', certifications: 'certifications', languages: 'languages' };

  /* The candidate has looked at / changed this section: its "Needs review" goes. No repaint - they are typing. */
  function touch(sec) {
    if (!sec) return;
    if (!S.touched[sec]) {
      S.touched[sec] = true;
      var box = document.getElementById('tlpoSec_' + sec);
      if (box) box.classList.remove('flag');
      var pill = document.getElementById('tlpoPill_' + sec);
      if (pill) pill.remove();
    }
    persist();
  }

  window.tlpoSet = function (key, v) {
    if (!S.form) return;
    S.form[key] = v;
    if (S.fieldErr[key]) delete S.fieldErr[key];
    touch(KEY_SECTION[key]);
  };

  window.tlpoMode = function (box) {
    if (!S.form) return;
    var v = box.value;
    var i = S.form.workModes.indexOf(v);
    if (box.checked && i < 0) S.form.workModes.push(v);
    if (!box.checked && i >= 0) S.form.workModes.splice(i, 1);
    delete S.fieldErr.modes;
    var lab = box.parentNode; if (lab && lab.classList) lab.classList.toggle('on', box.checked);
    persist();
  };

  window.tlpoRowSet = function (kind, i, key, v) {
    if (S.form && S.form[kind] && S.form[kind][i]) { S.form[kind][i][key] = v; touch(KIND_SECTION[kind]); }
  };
  window.tlpoRowAdd = function (kind) {
    if (!S.form) return;
    var blanks = {
      experience: { company: '', jobTitle: '', location: '', employmentType: '', responsibilities: '' },
      education: { qualification: '', specialization: '', institution: '', passingYear: '', score: '', educationType: '' },
      projects: { name: '', description: '' },
    };
    S.form[kind].push(JSON.parse(JSON.stringify(blanks[kind] || {})));
    touch(KIND_SECTION[kind]);
    paint();
    var el = document.getElementById('tlpoR_' + kind + '_' + (S.form[kind].length - 1) + '_' + Object.keys(blanks[kind])[0]);
    if (el) { try { el.focus(); } catch (e) { /* nothing */ } }
  };
  window.tlpoRowRemove = function (kind, i) {
    if (S.form && S.form[kind]) { S.form[kind].splice(i, 1); touch(KIND_SECTION[kind]); paint(); }
  };

  /* a tag field: Enter / comma adds, ✕ removes, the same entry twice (any case) is one */
  function refreshChips(kind) {
    var box = document.getElementById('tlpoChips_' + kind);
    if (!box || !S.form) { paint(); return; }
    var holder = document.createElement('div');
    holder.innerHTML = chips(kind, S.form[kind], box.getAttribute('data-ph') || '', box.getAttribute('data-lab') || '');
    box.parentNode.replaceChild(holder.firstChild, box);
  }
  window.tlpoChipAdd = function (kind, fromBlur) {
    var box = document.getElementById('tlpoChipIn_' + kind);
    if (!box || !S.form) return;
    var raw = String(box.value || '').replace(/,+$/, '');
    if (!raw.trim()) return;
    raw.split(',').forEach(function (part) {
      var v = part.trim().slice(0, 120);
      if (!v) return;
      var lower = v.toLowerCase();
      var dup = S.form[kind].some(function (x) { return String(x).trim().toLowerCase() === lower; });
      if (!dup && S.form[kind].length < 100) S.form[kind].push(v);
    });
    box.value = '';
    delete S.fieldErr[kind];
    touch(KIND_SECTION[kind]);
    refreshChips(kind);
    if (!fromBlur) {
      var again = document.getElementById('tlpoChipIn_' + kind);
      if (again) { try { again.focus(); } catch (e) { /* nothing */ } }
    }
  };
  window.tlpoChipKey = function (ev, kind) {
    if (ev.key === 'Enter' || ev.key === ',') { ev.preventDefault(); window.tlpoChipAdd(kind); }
    else if (ev.key === 'Backspace' && !ev.target.value && S.form && S.form[kind].length) {
      S.form[kind].pop(); touch(KIND_SECTION[kind]); refreshChips(kind);
      var again = document.getElementById('tlpoChipIn_' + kind);
      if (again) { try { again.focus(); } catch (e) { /* nothing */ } }
    }
  };
  window.tlpoChipRemove = function (kind, i) {
    if (S.form && S.form[kind]) { S.form[kind].splice(i, 1); touch(KIND_SECTION[kind]); refreshChips(kind); }
  };

  /* ------------------------------------------------------------------ *
   * progress, kept on the server
   * ------------------------------------------------------------------ */
  function draftBody() {
    return { form: S.form, flags: S.flags, touched: S.touched, parse: S.parse, parseState: S.parseState === 'failed' ? 'failed' : (S.parse ? 'done' : ''), resumeName: S.resumeName };
  }
  function persist(now) {
    if (S.persistT) { clearTimeout(S.persistT); S.persistT = null; }
    var go = function () {
      S.persistT = null;
      var c = me(), a = api();
      if (!c || !a || !S.form || S.step >= LAST || S.doneInfo) return;
      a.put('/candidates/' + encodeURIComponent(c.id) + '/onboarding',
        { status: 'in_progress', step: S.step, draft: draftBody() })
        .then(function (s) { if (s && s.status) setStatus(c, s.status); })
        .catch(function () { /* the next change tries again; nothing here is worth interrupting them over */ });
    };
    if (now) go(); else S.persistT = setTimeout(go, 700);
  }

  /* ------------------------------------------------------------------ *
   * the flow
   * ------------------------------------------------------------------ */
  window.tlpoBackdrop = function (ev) {
    if (ev && ev.target && ev.target.classList && ev.target.classList.contains('tlpo-ov')) {
      if (S.mode === 'modal') window.tlpoLater(); else window.tlpoClose();
    }
  };

  function restoreDraft(c, srv, step) {
    S.before = JSON.parse(JSON.stringify(c));
    S.form = blankForm(c);
    S.formFor = c.id;
    S.flags = {}; S.touched = {}; S.parse = null; S.parseState = ''; S.resumeName = '';
    S.error = ''; S.fieldErr = {}; S.doneInfo = null; S.step = 0;
    var d = srv && srv.status === 'in_progress' && srv.draft;
    if (d && d.form) {
      Object.keys(S.form).forEach(function (k) { if (d.form[k] !== undefined) S.form[k] = d.form[k]; });
      S.flags = d.flags || {}; S.touched = d.touched || {};
      S.parse = d.parse || null; S.resumeName = d.resumeName || '';
      S.parseState = d.parseState === 'failed' ? 'failed' : '';
      S.step = Math.max(0, Math.min(LAST - 1, Number(srv.step) || 0));
    }
    if (typeof step === 'number') S.step = Math.max(0, Math.min(LAST - 1, step));
  }

  window.tlpoStart = function (step) {
    var c = me(), a = api();
    if (!c) return;
    S.mode = 'wizard';
    S.focusTitle = true;
    if (S.form && S.formFor === c.id) {
      if (typeof step === 'number') S.step = Math.max(0, Math.min(LAST - 1, step));
      S.error = '';
      paint();
      persist(true);
      return;
    }
    S.loading = true; paint();
    var finish = function (srv) {
      S.loading = false;
      restoreDraft(c, srv, step);
      if (statusOf(c) !== 'in_progress') setStatus(c, 'in_progress');
      S.focusTitle = true;
      paint();
      persist(true);
    };
    if (!a) { finish(null); return; }
    a.get('/candidates/' + encodeURIComponent(c.id) + '/onboarding').then(finish, function () { finish(null); });
  };

  window.tlpoClose = function () {
    persist(true);
    S.mode = null; S.error = '';
    paint();
    if (typeof window.render === 'function') window.render();
  };

  /* "Later": remembered on the server, and from the next sign-in a banner instead of a box. */
  window.tlpoLater = function () {
    var c = me();
    S.mode = null;
    paint();
    var a = api();
    if (a && c) {
      if (statusOf(c) === 'not_started') setStatus(c, 'skipped');
      a.put('/candidates/' + encodeURIComponent(c.id) + '/onboarding', { status: 'skipped' }).catch(function () { /* never worth interrupting them over */ });
      a.post('/candidates/' + encodeURIComponent(c.id) + '/onboarding-later', {})
        .then(function (res) { try { c.onboardingLaterCount = res.laterCount; } catch (e) { /* nothing */ } })
        .catch(function () { /* nothing */ });
    }
    /* to the Job Portal Home - unless they are already inside the candidate portal */
    if (!/^#\/candidate\//.test(location.hash || '') && typeof window.navigate === 'function') window.navigate(HOME);
    else if (typeof window.render === 'function') window.render();
  };

  window.tlpoBack = function () {
    if (S.saving || S.step === 0) return;
    S.step = S.step === LAST ? 3 : Math.max(0, S.step - 1);
    /* the reading screen is only a way through: backing out of the review goes to the resume, not back to "reading" */
    if (S.step === 1 && !S.parse && S.parseState !== 'failed') S.step = 0;
    S.error = ''; S.focusTitle = true; paint(); persist();
  };

  /* ---- the resume step ------------------------------------------------ */
  window.tlpoDrag = function (ev, on) {
    ev.preventDefault();
    var d = document.getElementById('tlpoDrop');
    if (d) d.classList.toggle('over', !!on);
  };
  window.tlpoDrop = function (ev) {
    ev.preventDefault();
    var d = document.getElementById('tlpoDrop');
    if (d) d.classList.remove('over');
    var f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
    if (f) takeResume(f);
  };
  window.tlpoPicked = function (input) {
    var f = input && input.files && input.files[0];
    if (f) takeResume(f);
  };

  function takeResume(file) {
    var name = String(file.name || '');
    var ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
    if (ACCEPT.indexOf(ext) < 0) {
      S.error = 'That file is a .' + (ext || 'unknown') + '. Please upload a PDF, DOC or DOCX.';
      paint(); return;
    }
    if (!file.size) { S.error = 'That file is empty. Please choose your resume.'; paint(); return; }
    if (file.size > MAX_RESUME_BYTES) {
      S.error = 'That file is ' + (file.size / 1048576).toFixed(1) + ' MB. The limit is 5 MB.';
      paint(); return;
    }
    var c = me(), a = api();
    if (!c || !a) { S.error = 'The server could not be reached.'; paint(); return; }

    S.error = ''; S.resumeName = name; S.parseState = 'uploading'; S.saving = true; S.step = 0;
    paint();
    setTimeout(function () { if (S.parseState === 'uploading') { S.parseState = 'reading'; paint(); } }, 500);

    var fd = new FormData();
    fd.append('resume', file);
    a.post('/candidates/' + encodeURIComponent(c.id) + '/onboarding/resume', fd, { timeout: 90000 }).then(function (res) {
      S.saving = false;
      adopt(res.candidate);
      S.resumeName = (res.resume && res.resume.fileName) || name;
      readDone(res.parse);
    }, function (err) {
      S.saving = false; S.parseState = ''; S.resumeName = '';
      S.error = ((err && err.message) || 'The upload did not go through.') + ' You can try again, or skip this and type your details in.';
      paint();
    });
  }

  /* what the reading gave: into the working copy (never over what is there), then the "what we read" screen */
  function readDone(parse) {
    if (!parse || !parse.ok) {
      S.parse = { ok: false }; S.parseState = 'failed';
    } else {
      S.parse = { ok: true, counts: adoptParse(parse) };
      S.parseState = 'done';
    }
    S.step = 1; S.focusTitle = true;
    paint(); persist();
  }

  /* Continue with the resume already on file: read it, change nothing */
  function readExisting() {
    var c = me(), a = api();
    if (!c || !a) return;
    S.error = ''; S.step = 1; S.parseState = 'reading'; S.saving = true;
    S.resumeName = c.resumeFile || S.resumeName;
    paint();
    a.post('/candidates/' + encodeURIComponent(c.id) + '/onboarding/read', {}, { timeout: 60000 }).then(function (res) {
      S.saving = false; readDone(res.parse);
    }, function (err) {
      S.saving = false; S.parseState = 'failed'; S.parse = { ok: false };
      S.error = (err && err.message) || '';
      paint();
    });
  }

  window.tlpoRemoveResume = function () {
    var c = me(), a = api();
    if (!c || !a || S.saving) return;
    S.saving = true; S.error = ''; paint();
    a.del('/candidates/' + encodeURIComponent(c.id) + '/onboarding/resume').then(function (res) {
      S.saving = false; adopt(res.candidate);
      S.resumeName = ''; S.parse = null; S.parseState = '';
      toast('Resume removed', '🗑️');
      paint();
    }, function (err) {
      S.saving = false; S.error = (err && err.message) || 'That could not be removed.'; paint();
    });
  };

  window.tlpoSkipResume = function () {
    if (S.saving) return;
    S.error = ''; S.step = 2; S.focusTitle = true; paint(); persist();
  };

  /* ---- moving on ----------------------------------------------------- */
  function detailProblems() {
    var f = S.form, h = have(), e = {};
    if (!h.location && blank(f.currentLocation)) e.location = 'Please enter your current location.';
    if (!h.preferredLocation && !f.preferredLocations.length) e.preferredLocations = 'Add at least one preferred location.';
    if (!h.noticePeriod && !f.noticePeriod) e.noticePeriod = 'Please choose your notice period.';
    if (!h.expectedCtc) {
      var n = Number(f.salaryAmount);
      var lakh = f.salaryUnit === 'month' ? (n * 12 / 100000) : n;
      if (blank(f.salaryAmount) || !(n > 0)) e.salary = 'Please enter your expected salary.';
      else if (lakh > 1000) e.salary = 'That looks too high - enter it in lakh per annum.';
    }
    if (!h.preferredRole && !f.preferredRoles.length) e.preferredRoles = 'Add at least one preferred role.';
    if (!h.workModes && !f.workModes.length) e.modes = 'Choose at least one work mode.';
    return e;
  }

  window.tlpoNext = function () {
    if (S.saving) return;
    S.error = '';
    if (S.step === 0) {
      var c = me();
      if (c && c.resumeFile) { readExisting(); return; }
      S.error = 'Upload your resume, or choose "Skip" to type your details in.';
      paint(); return;
    }
    if (S.step === 1) { S.step = 2; S.focusTitle = true; paint(); persist(); return; }
    if (S.step === 2) {
      var pe = {};
      if (!blank(S.form.phone) && !/^(?:\+?91[\s-]?|0)?[6-9]\d{9}$/.test(String(S.form.phone).replace(/[\s-]/g, ''))) pe.phone = 'Enter a valid 10-digit mobile number.';
      if (!blank(S.form.name) && String(S.form.name).trim().length < 2) pe.name = 'Please enter your name.';
      S.fieldErr = pe;
      if (Object.keys(pe).length) { S.error = 'Please check the highlighted fields.'; paint(); return; }
      Object.keys(S.flags).forEach(function (k) { S.touched[k] = true; });   // confirmed
      S.step = 3; S.focusTitle = true; paint(); persist(); return;
    }
    if (S.step === 3) {
      S.fieldErr = detailProblems();
      if (Object.keys(S.fieldErr).length) {
        S.error = 'Please complete the highlighted fields.';
        paint();
        var first = document.querySelector('#tlpoBody .tlpo-f.bad');
        if (first && first.scrollIntoView) first.scrollIntoView({ block: 'center' });
        return;
      }
      finish(); return;
    }
    if (S.step === LAST) finish();
  };

  /* ---- finish: one request, one transaction ---------------------------- */
  function finish() {
    var c = me(), a = api();
    if (!c || !a) { S.error = 'The server could not be reached.'; paint(); return; }
    var f = S.form, h = have();
    S.step = LAST; S.saving = true; S.error = ''; S.focusTitle = true;
    paint();

    var body = {
      skills: f.skills, certifications: f.certifications, languages: f.languages,
      projects: f.projects.filter(function (p) { return !blank(p.name); }).map(function (p) { return { name: p.name, description: p.description || '' }; }),
      educationRecords: f.education.filter(function (r) { return !blank(r.qualification) || !blank(r.institution) || !blank(r.specialization); }),
      experienceRecords: f.experience.filter(function (r) { return !blank(r.company) || !blank(r.jobTitle); }),
      summary: String(f.summary || '').trim(),
      title: String(f.title || '').trim(),
      currentCompany: String(f.currentCompany || '').trim(),
    };
    if (!blank(f.name)) body.name = String(f.name).trim();
    if (!blank(f.phone)) body.phone = String(f.phone).trim();
    if (!blank(f.expYears) && Number.isFinite(Number(f.expYears))) body.expYears = Number(f.expYears);
    /* only what was asked: what they gave before is left exactly as it is */
    if (!h.location) body.location = String(f.currentLocation).trim();
    if (!h.preferredLocation) body.preferredLocation = f.preferredLocations.join(', ');
    if (!h.noticePeriod) body.noticePeriod = f.noticePeriod;
    if (!h.expectedCtc) {
      var n = Number(f.salaryAmount);
      body.expectedCtc = f.salaryUnit === 'month' ? Math.round((n * 12 / 100000) * 100) / 100 : n;
    }
    if (!h.preferredRole) body.preferredRole = f.preferredRoles.join(', ');
    if (!h.workModes) body.preferredWorkModes = f.workModes.slice();

    a.post('/candidates/' + encodeURIComponent(c.id) + '/onboarding/complete', body, { timeout: 60000 }).then(function (res) {
      S.saving = false;
      adopt(res.candidate);
      setStatus(c, 'completed');
      var pct = completion(me() || c);
      S.doneInfo = { pct: pct };
      paint();
      setTimeout(function () {
        S.mode = null; S.form = null; S.formFor = null; S.step = 0; S.doneInfo = null; S.parse = null; S.parseState = '';
        paint();
        toast('✓ Profile ready — ' + pct + '% complete', '✅');
        if (typeof window.navigate === 'function') window.navigate(HOME);
        else if (typeof window.render === 'function') window.render();
      }, 1800);
    }, function (err) {
      /* NOTHING IS LOST. The working copy is untouched, so they press the button again rather than
         typing it all a second time - and a retry cannot make a second copy of anything. */
      S.saving = false;
      var d = (err && (err.details || err.fields)) || {};
      var map = { location: 'location', preferredLocation: 'preferredLocations', noticePeriod: 'noticePeriod', expectedCtc: 'salary', preferredRole: 'preferredRoles', preferredWorkModes: 'modes', name: 'name', phone: 'phone' };
      var back = false;
      Object.keys(d).forEach(function (k) { if (map[k]) { S.fieldErr[map[k]] = d[k]; back = back || /location|noticePeriod|expectedCtc|preferredRole|preferredWorkModes/.test(k); } });
      if (Object.keys(d).length) { S.step = back ? 3 : 2; S.error = 'Please check the highlighted fields.'; }
      else S.error = ((err && err.message) || 'That did not save.') + ' Nothing was lost - press the button to try again.';
      paint();
    });
  }

  function adopt(candidate) {
    if (!candidate || !candidate.id) return;
    try {
      var i = DATA.candidates.findIndex(function (x) { return x.id === candidate.id; });
      if (i >= 0) Object.assign(DATA.candidates[i], candidate);
      else DATA.candidates.push(candidate);
    } catch (e) { /* the next bootstrap refetches anyway */ }
  }

  /* ------------------------------------------------------------------ *
   * the banner: for anyone who said Later, or stopped half way
   * ------------------------------------------------------------------ */
  window.tlpoBannerHide = function () {
    S.bannerHidden = true;
    var b = document.getElementById('tlpoBanner');
    if (b) b.remove();
  };

  function bannerHtml(c) {
    var started = statusOf(c) === 'in_progress';
    return '<div class="tlpo-banner" id="tlpoBanner" role="region" aria-label="Complete your profile">'
      + ring(completion(c), 44)
      + '<div class="tlpo-banner-t"><b>Complete your profile</b>'
      +   '<span>Your profile is ' + completion(c) + '% complete. Finish it to get better job matches.</span></div>'
      + '<button class="tlpo-btn pri sm" onclick="tlpoStart()">' + (started ? 'Continue' : 'Complete') + '</button>'
      + '<button class="tlpo-x sm" onclick="tlpoBannerHide()" aria-label="Hide for now">✕</button>'
      + '</div>';
  }

  function placeBanner(c) {
    if (S.bannerHidden) return;
    var old = document.getElementById('tlpoBanner');
    if (old) {
      /* the percentage moves as the profile does */
      if (old.getAttribute('data-pct') === String(completion(c))) return;
      old.remove();
    }
    if (!/^#\/candidate\//.test(location.hash || '')) return;

    var app = document.getElementById('app');
    if (!app) return;
    var el = document.createElement('div');
    el.innerHTML = bannerHtml(c);
    var node = el.firstChild;
    node.setAttribute('data-pct', String(completion(c)));

    /* UNDER THE HEADER, NEVER ABOVE IT: above it the sticky header looks as if it does not stick. */
    var header = app.querySelector(':scope > .cp-hd, :scope > header');
    if (header && header.parentNode) {
      header.parentNode.insertBefore(node, header.nextSibling);
      return;
    }
    var target = app.querySelector('.cap-wrap, .cap-main, .wrap') || app;
    if (target.firstChild) target.insertBefore(node, target.firstChild);
    else target.appendChild(node);
  }

  /* ------------------------------------------------------------------ *
   * when to offer it
   * ------------------------------------------------------------------ */
  function consider() {
    var c = me();
    if (!c) return;

    /* DONE IS DONE. A finished profile - or one that is built enough - is never asked about again. */
    var status = statusOf(c);
    if (status === 'completed' || built(c)) {
      var b = document.getElementById('tlpoBanner'); if (b) b.remove();
      return;
    }
    if (S.mode === 'wizard') return;       // they are in it

    var h = String(location.hash || '');
    if (/reset-password|forgot-password/.test(h)) return;
    if (location.pathname === '/reset-password') return;

    /* A candidate looking at a job is there to apply (Apply Now is one click and asks nothing), so the box
       does not cover the job page. It is asked again on the next page that is not a job. */
    if (/^#\/job\//.test(h)) {
      if (S.mode === 'modal') { S.mode = null; S.askedThisVisit = false; paint(); }
      return;
    }

    /* An application being submitted, or its confirmation on screen: ask after, not on top of it. */
    if (window.TLOneClickApply && typeof TLOneClickApply.holding === 'function'
        && TLOneClickApply.holding()) return;

    /* First time: the OK / Later box. After Later, or after closing the wizard half way: a quiet banner. */
    if (status === 'not_started') {
      if (S.askedThisVisit || S.mode) return;
      S.askedThisVisit = true;
      S.mode = 'modal';
      paint();
      return;
    }
    placeBanner(c);
    /* and one non-blocking reminder per browser session */
    try {
      if (status !== 'not_started' && !sessionStorage.getItem('tlpo_reminded_' + c.id)) {
        sessionStorage.setItem('tlpo_reminded_' + c.id, '1');
        toast('Complete your profile (' + completion(c) + '%) to get better job matches.', '📝');
      }
    } catch (e) { /* private mode: the banner is still there */ }
  }

  /* ------------------------------------------------------------------ *
   * wiring
   * ------------------------------------------------------------------ */
  /** Whether the profile counts as built (the prompt stops then). */
  window.tlpoBuilt = function () { var c = me(); return statusOf(c) === 'completed' || built(c); };

  window.tlpoStartAt = function (fieldKey) {
    var k = String(fieldKey || '');
    var step = k === 'resumeFile' ? 0
      : (k === 'preferredLocation' || k === 'expectedCtc' || k === 'noticePeriod') ? 3 : 2;
    window.tlpoStart(step);
  };

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && S.mode === 'wizard' && !S.saving && !S.doneInfo) window.tlpoClose();
  });

  var originalRender = window.render;
  if (typeof originalRender === 'function') {
    window.render = function () {
      var out = originalRender.apply(this, arguments);
      setTimeout(function () { try { consider(); } catch (e) { /* never in the way */ } }, 0);
      return out;
    };
  }

  var originalSubmitLogin = window.submitLogin;
  if (typeof originalSubmitLogin === 'function') {
    window.submitLogin = function () {
      S.askedThisVisit = false;
      S.bannerHidden = false;
      S.form = null; S.formFor = null; S.local = {};
      return originalSubmitLogin.apply(this, arguments);
    };
  }

  /* ------------------------------------------------------------------ *
   * styles
   * ------------------------------------------------------------------ */
  var css = ''
    + '.tlpo-ov{position:fixed;inset:0;background:rgba(18,32,48,.38);z-index:9000;'
      + 'display:flex;align-items:center;justify-content:center;padding:20px}'
    + '.tlpo-card{background:#fff;border-radius:16px;width:100%;max-width:640px;'
      + 'box-shadow:0 18px 50px rgba(16,32,52,.22);overflow:hidden;'
      + 'font-family:inherit;color:#16202c;display:flex;flex-direction:column;max-height:92vh}'
    + '.tlpo-modal{padding:26px 26px 18px;max-width:520px}'
    + '.tlpo-modal-top{display:flex;gap:18px;align-items:center}'
    + '.tlpo-card h2{margin:0;font-size:19px;font-weight:800;letter-spacing:-.01em}'
    + '.tlpo-card p{margin:6px 0 0;font-size:13.5px;color:#55677d;line-height:1.5}'
    + '.tlpo-acts{display:flex;gap:10px;justify-content:flex-end;align-items:center;'
      + 'padding:18px 0 0;flex-wrap:wrap}'
    + '.tlpo-wiz .tlpo-acts{padding:14px 22px;border-top:1px solid #eef2f7;background:#fbfcfe}'
    + '.tlpo-btn{border:0;border-radius:9px;padding:10px 18px;font:inherit;font-size:13.5px;'
      + 'font-weight:700;cursor:pointer}'
    + '.tlpo-btn.pri{background:#1490b3;color:#fff}'
    + '.tlpo-btn.pri:hover{background:#117a99}'
    + '.tlpo-btn.ghost{background:#eef3f8;color:#3a4a5e}'
    + '.tlpo-btn.sm{padding:7px 13px;font-size:12.5px}'
    + '.tlpo-btn[disabled]{opacity:.55;cursor:default}'
    + '.tlpo-skip{background:none;border:0;color:#6b7a8d;font:inherit;font-size:12.5px;'
      + 'text-decoration:underline;cursor:pointer;margin-right:auto;padding:8px 2px}'
    + '.tlpo-head{display:flex;gap:14px;align-items:center;padding:20px 22px 12px}'
    + '.tlpo-head>div:first-child{flex:1;min-width:0}'
    + '.tlpo-step{font-size:11.5px;font-weight:800;letter-spacing:.06em;'
      + 'text-transform:uppercase;color:#1490b3;margin-bottom:3px}'
    + '.tlpo-x{background:none;border:0;font-size:15px;color:#8a97a6;cursor:pointer;'
      + 'padding:6px;line-height:1;align-self:flex-start}'
    + '.tlpo-x:hover{color:#d4342c}'
    + '.tlpo-dots{display:flex;gap:5px;padding:0 22px 14px}'
    + '.tlpo-dots i{height:4px;flex:1;border-radius:3px;background:#e4ecf4}'
    + '.tlpo-dots i.on{background:#1490b3}'
    + '.tlpo-dots i.done{background:#7fc4d8}'
    + '.tlpo-body{padding:4px 22px 18px;overflow:auto}'
    + '.tlpo-h{margin:18px 0 8px;font-size:12px;font-weight:800;letter-spacing:.04em;'
      + 'text-transform:uppercase;color:#5f7183}'
    + '.tlpo-h:first-of-type{margin-top:8px}'
    + '.tlpo-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px 14px}'
    + '.tlpo-f{display:flex;flex-direction:column;gap:5px;margin-bottom:12px}'
    + '.tlpo-f.wide{grid-column:1 / -1}'
    + '.tlpo-l{font-size:12px;font-weight:700;color:#41506a}'
    + '.tlpo-i{width:100%;padding:9px 11px;border:1px solid #d7dfea;border-radius:9px;'
      + 'font:inherit;font-size:13.5px;background:#fff;color:#16202c;box-sizing:border-box}'
    + '.tlpo-i:focus{outline:0;border-color:#1490b3;box-shadow:0 0 0 3px rgba(20,144,179,.14)}'
    + '.tlpo-ta{resize:vertical;min-height:58px;line-height:1.5}'
    + '.tlpo-hint{font-size:11.5px;color:#7a8798}'
    + '.tlpo-note{font-size:12.5px;color:#55677d;line-height:1.55;margin:4px 0 10px}'
    + '.tlpo-picked{background:#f2f8fb;border:1px solid #d7e7ef;border-radius:9px;'
      + 'padding:9px 12px}'
    + '.tlpo-status{font-size:12.5px;font-weight:700;color:#0e7490;margin-top:10px}'
    + '.tlpo-err{background:#fef3f2;border:1px solid #fecdca;color:#b42318;border-radius:9px;'
      + 'padding:10px 12px;font-size:12.5px;margin-bottom:14px;line-height:1.45}'
    + '.tlpo-drop{border:2px dashed #cfdcea;border-radius:12px;background:#f8fbfd;'
      + 'padding:26px 18px;text-align:center;display:flex;flex-direction:column;'
      + 'align-items:center;gap:7px}'
    + '.tlpo-drop.over{border-color:#1490b3;background:#eef8fc}'
    + '.tlpo-drop-ic{font-size:30px;line-height:1}'
    + '.tlpo-drop b{font-size:14px}'
    + '.tlpo-drop span{font-size:12px;color:#7a8798}'
    + '.tlpo-file{font-size:12.5px;font-weight:700;color:#0e7490;margin-top:4px;'
      + 'word-break:break-all}'
    + '.tlpo-bar{height:5px;background:#e4ecf4;border-radius:3px;overflow:hidden;margin-top:14px}'
    + '.tlpo-bar i{display:block;height:5px;width:45%;background:#1490b3}'
    + '.tlpo-rows{display:flex;flex-direction:column;gap:10px}'
    + '.tlpo-row{position:relative;border:1px solid #e9edf3;border-radius:10px;'
      + 'padding:12px 34px 2px 12px;background:#fbfcfe;'
      + 'display:grid;grid-template-columns:1fr 1fr;gap:10px 12px}'
    + '.tlpo-rowx{position:absolute;top:8px;right:8px;border:0;background:transparent;'
      + 'cursor:pointer;color:#8a97a6;font-size:12px;padding:4px}'
    + '.tlpo-rowx:hover{color:#d4342c}'
    + '.tlpo-add{align-self:flex-start;border:1px dashed #b9cbdd;background:#fff;'
      + 'color:#1490b3;border-radius:9px;padding:7px 13px;font:inherit;font-size:12.5px;'
      + 'font-weight:700;cursor:pointer}'
    + '.tlpo-chips{display:flex;flex-wrap:wrap;gap:6px;border:1px solid #d7dfea;'
      + 'border-radius:9px;padding:7px 8px;background:#fff;min-height:40px;align-items:center}'
    + '.tlpo-chip{display:inline-flex;align-items:center;gap:5px;background:#eaf5f9;'
      + 'color:#0e5a70;border-radius:999px;padding:3px 6px 3px 10px;font-size:12.5px}'
    + '.tlpo-chip button{border:0;background:none;color:#4e7f90;cursor:pointer;'
      + 'font-size:11px;padding:0 2px;line-height:1}'
    + '.tlpo-chip button:hover{color:#b42318}'
    + '.tlpo-chipin{flex:1;min-width:150px;border:0;outline:0;font:inherit;font-size:13px;'
      + 'padding:4px 2px;background:transparent}'
    + '.tlpo-money{display:flex;align-items:center;gap:8px}'
    + '.tlpo-cur{font-size:15px;font-weight:700;color:#41506a}'
    + '.tlpo-unit{flex:0 0 150px;width:150px}'
    + '.tlpo-foot{font-size:11.5px;color:#8a97a6;text-align:center;padding:0 22px 14px}'
    + '.tlpo-banner{display:flex;align-items:center;gap:13px;background:#fff;'
      + 'border:1px solid #d9e7f0;border-left:4px solid #1490b3;border-radius:12px;'
      + 'padding:12px 14px;margin:0 0 16px;box-shadow:0 2px 10px rgba(16,32,52,.05)}'
    + '.tlpo-banner-t{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}'
    + '.tlpo-banner-t b{font-size:13.5px}'
    + '.tlpo-banner-t span{font-size:12px;color:#6b7a8d;line-height:1.4}'
    + '.tlpo-sec{border:1px solid #e3eaf2;border-radius:12px;padding:12px 14px 4px;margin:0 0 12px;background:#fff}'
    + '.tlpo-sec.key{border-color:#9fd0e0;background:#f3fafc}'
    + '.tlpo-sec.flag{border-color:#f0c36d;background:#fffaf0}'
    + '.tlpo-sec-h{display:flex;align-items:center;gap:10px;margin-bottom:6px}'
    + '.tlpo-sec-h .tlpo-h{margin:0}'
    + '.tlpo-pill{background:#fff1d6;color:#8a5a00;border:1px solid #f0c36d;border-radius:999px;padding:1px 9px;font-size:11px;font-weight:800}'
    + '.tlpo-f.bad .tlpo-i,.tlpo-f.bad .tlpo-chips{border-color:#d4342c}'
    + '.tlpo-ferr{font-size:11.5px;color:#b42318;font-weight:600}'
    + '.tlpo-onfile{display:flex;align-items:center;gap:12px;border:1px solid #d7e7ef;background:#f2f8fb;border-radius:12px;padding:14px;flex-wrap:wrap}'
    + '.tlpo-file-ic{font-size:26px}'
    + '.tlpo-file-t{flex:1;min-width:160px;display:flex;flex-direction:column;gap:2px;word-break:break-all}'
    + '.tlpo-file-t span{font-size:12px;color:#6b7a8d}'
    + '.tlpo-file-a{display:flex;gap:8px}'
    + '.tlpo-reading{display:flex;flex-direction:column;align-items:center;gap:8px;padding:26px 8px;text-align:center}'
    + '.tlpo-reading span{font-size:12.5px;color:#6b7a8d}'
    + '.tlpo-spin{width:30px;height:30px;border:3px solid #d7e7ef;border-top-color:#1490b3;border-radius:50%;animation:tlpospin .8s linear infinite}'
    + '@keyframes tlpospin{to{transform:rotate(360deg)}}'
    + '.tlpo-ok{display:flex;flex-direction:column;gap:2px;margin-bottom:12px}'
    + '.tlpo-ok b{color:#0e7490}.tlpo-ok span{font-size:12px;color:#6b7a8d;word-break:break-all}'
    + '.tlpo-counts{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:10px}'
    + '.tlpo-count{border:1px solid #d9e7f0;border-radius:10px;padding:10px;text-align:center;background:#f8fbfd}'
    + '.tlpo-count b{display:block;font-size:20px;color:#0e5a70}.tlpo-count span{font-size:11.5px;color:#55677d}'
    + '.tlpo-count.zero{opacity:.55}'
    + '.tlpo-modes{display:flex;gap:8px;flex-wrap:wrap}'
    + '.tlpo-mode{display:flex;align-items:center;gap:7px;border:1px solid #d7dfea;border-radius:9px;padding:8px 12px;font-size:13px;cursor:pointer;background:#fff}'
    + '.tlpo-mode.on{border-color:#1490b3;background:#eaf5f9}'
    + '.tlpo-ready{display:flex;flex-direction:column;align-items:center;text-align:center;gap:6px;padding:18px 8px}'
    + '.tlpo-ready h3{margin:6px 0 0;font-size:19px}'
    + '.tlpo-body:focus,#tlpoTitle:focus{outline:0}'
    + '@media (max-width:680px){.tlpo-counts{grid-template-columns:repeat(2,1fr)}.tlpo-onfile{flex-direction:column;align-items:flex-start}}'
    /* Full screen on a phone: a form this long in a 92vh box with a
       keyboard open is unusable otherwise. */
    + '@media (max-width:680px){'
      + '.tlpo-ov{padding:0;align-items:stretch}'
      + '.tlpo-card{max-width:none;border-radius:0;max-height:100%;height:100%}'
      + '.tlpo-modal{padding:22px 18px;justify-content:center}'
      + '.tlpo-modal-top{flex-direction:column;text-align:center;gap:12px}'
      + '.tlpo-grid,.tlpo-row{grid-template-columns:1fr}'
      + '.tlpo-acts{padding:14px 16px;gap:8px}'
      + '.tlpo-btn{flex:1;text-align:center}'
      + '.tlpo-skip{margin-right:0;width:100%;text-align:center;order:3}'
      + '.tlpo-banner{flex-wrap:wrap}'
    + '}';

  var tag = document.createElement('style');
  tag.id = 'tlpo-css';
  tag.textContent = css;
  (document.head || document.documentElement).appendChild(tag);
}());
