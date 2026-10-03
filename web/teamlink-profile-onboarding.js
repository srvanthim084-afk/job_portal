/* =====================================================================
   TEAMLINK — "Build your profile"

   THE GAP THIS FILLS. A candidate added from the Talent Pool is emailed
   a login, signs in, chooses a password, and arrives at a profile that
   is ten per cent filled in and says "9 missing details" - with no
   indication of which nine, why they matter, or where to start.

   THREE STEPS, in the order that does the most work for the least
   typing:

     1  the CV
     2  what we read out of it, every field editable
     3  the five things a CV cannot tell us

   STEP 3 IS NEVER PREFILLED FROM THE CV. Notice period, location,
   preferred locations, preferred roles and expected salary decide which
   jobs a candidate is shown and what a recruiter quotes on their behalf.
   A regular expression that finds "3 months" somewhere in a paragraph is
   not the candidate saying their notice period, and a stray match there
   is worse than a blank field. They are asked, plainly.

   IT NEVER BLOCKS. "Later" closes everything and the portal works
   normally. Parsing that finds nothing is not a failure either - the
   steps are simply empty and typed by hand.

   WHERE "LATER" IS REMEMBERED. On the candidate record, not in
   localStorage (0074), so saying it on a phone is still saying it on a
   borrowed laptop.

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

  var LATER_LIMIT = 3;
  var MAX_RESUME_BYTES = 5 * 1024 * 1024;
  var ACCEPT = ['pdf', 'doc', 'docx'];

  /* Built enough to stop asking: a CV on file and most of the profile
     filled in. Not 100% - the last few fields are optional by nature and
     nagging for them is what gets a prompt dismissed unread. */
  var BUILT_AT = 70;

  var NOTICE = ['Immediate', '15 days', '30 days', '60 days', '90 days', 'Other'];

  var S = {
    mode: null,          // null | 'modal' | 'wizard'
    step: 0,
    saving: false,
    error: '',
    resumeName: '',
    parsedCount: 0,
    parseState: '',      // '' | 'uploading' | 'reading' | 'done' | 'failed'
    bannerHidden: false,
    askedThisVisit: false,
    /* What the record held BEFORE any upload. Step 3 is seeded from this
       and never from the parse. */
    before: null,
    form: null,
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

  var STEPS = ['Your CV', 'What we read', 'A few more details'];

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
   * Everything the candidate has touched lives here until Save, so a
   * failed save loses nothing and a Back keeps their edits.
   * ------------------------------------------------------------------ */
  function blankForm(c) {
    return {
      name: c.name || '', email: c.email || '', phone: c.phone || '',
      location: c.location || '',
      summary: c.summary || '',
      skills: (c.skills || []).slice(),
      certifications: (c.certifications || []).slice(),
      languages: (c.languages || []).slice(),
      projects: (c.projects || []).map(function (p) {
        return typeof p === 'string' ? { name: p, description: '' } : {
          name: p.name || '', description: p.desc || p.description || '',
        };
      }),
      /*
       * SEEDED FROM WHAT IS ALREADY SAVED, and this is not cosmetic.
       *
       * Save REPLACES both lists rather than merging them, because the
       * candidate is looking at the whole list when they press it. So a
       * wizard that opened with these empty would delete the jobs and
       * qualifications they had entered earlier - reopening it to change
       * one city would silently wipe their work history.
       */
      experience: (c.experienceRecords || []).map(function (x) {
        return {
          company: x.company || '', jobTitle: x.jobTitle || '',
          location: x.location || '', employmentType: x.employmentType || '',
          responsibilities: x.responsibilities || '',
        };
      }),
      education: (c.educationRecords || []).map(function (e) {
        return {
          qualification: e.qualification || '', specialization: e.specialization || '',
          institution: e.institution || '',
          passingYear: e.passingYear == null ? '' : String(e.passingYear),
          score: e.score || '',
        };
      }),
      /* Step 3. Seeded ONLY from what the record already held, never
         from the CV. */
      /* Already answered means already answered. These two were being
         left blank, so the step reopened as "Still needed: notice
         period, expected salary" for somebody who had given both - and
         the Save button stayed refused until they typed them again. Only
         a value from the recognised list is adopted; anything else is
         left for them to choose, rather than shown as a selection that
         is not really there. */
      noticePeriod: NOTICE.indexOf(String(c.noticePeriod || '')) >= 0
        ? String(c.noticePeriod) : '',
      currentLocation: c.location || '',
      preferredLocations: c.preferredLocation
        ? String(c.preferredLocation).split(',').map(function (x) { return x.trim(); })
            .filter(Boolean) : [],
      preferredRoles: c.preferredRole
        ? String(c.preferredRole).split(',').map(function (x) { return x.trim(); })
            .filter(Boolean) : [],
      /* Stored in lakh per annum, which is what the "per annum" unit
         means here, so it goes back into the field as it was given. */
      salaryAmount: c.expectedCtc ? String(c.expectedCtc) : '',
      salaryUnit: 'year',
    };
  }

  /** What the parser found, folded into the working copy. Anything the
      CV did not contain is left exactly as it was. */
  function adoptParse(fields) {
    var f = S.form;
    if (!f || !fields) return 0;
    var filled = 0;
    var put = function (key, v) {
      if (v === undefined || v === null || v === '') return;
      if (Array.isArray(v) && !v.length) return;
      f[key] = v; filled += 1;
    };

    put('name', fields.name);
    put('email', fields.email);
    put('phone', fields.phone);
    put('location', fields.location);
    put('summary', fields.summary);
    /*
     * ADDED TO, NOT SUBSTITUTED FOR - the same rule as the rows below.
     * A candidate with "Critical Care" on file who uploads a CV listing
     * three other skills should end up with four, not three: the CV is
     * evidence of what they can do, not a statement that the rest was
     * wrong. Matched case-insensitively so the same skill written two
     * ways is listed once.
     */
    var mergeList = function (key, incoming) {
      if (!incoming.length) return;
      var seen = {}, added = 0;
      f[key].forEach(function (x) { seen[String(x).trim().toLowerCase()] = true; });
      incoming.forEach(function (x) {
        var k = String(x || '').trim().toLowerCase();
        if (!k || seen[k]) return;
        seen[k] = true; f[key].push(String(x).trim()); added += 1;
      });
      if (added) filled += 1;
    };
    mergeList('skills', fields.skills || []);
    mergeList('certifications', fields.certifications || []);
    mergeList('languages', fields.languages || []);

    if ((fields.projects || []).length) {
      var pseen = {};
      f.projects.forEach(function (x) { pseen[String(x.name || '').trim().toLowerCase()] = true; });
      var padded = 0;
      fields.projects.forEach(function (name) {
        var k = String(name || '').trim().toLowerCase();
        if (!k || pseen[k]) return;
        pseen[k] = true;
        f.projects.push({ name: String(name).trim(), description: '' });
        padded += 1;
      });
      if (padded) filled += 1;
    }

    /*
     * Work history and education as ROWS, not paragraphs - the whole
     * point of the review step is that each job can be corrected on its
     * own.
     *
     * ADDED TO WHAT IS THERE, NOT SUBSTITUTED FOR IT. These lists now
     * arrive seeded from what the candidate has already saved, and Save
     * replaces the stored list with this one. Overwriting them here
     * would mean a candidate with three jobs on file who uploads a CV
     * that yields one loses the other two - without being asked, and
     * without being told. A row already present is not added twice.
     */
    var mergeRows = function (kind, incoming, keyOf) {
      if (!incoming.length) return;
      var seen = {};
      f[kind].forEach(function (r) { seen[keyOf(r)] = true; });
      var added = 0;
      incoming.forEach(function (r) {
        var k = keyOf(r);
        if (k === '|' || seen[k]) return;      // nothing in it, or already listed
        seen[k] = true; f[kind].push(r); added += 1;
      });
      if (added) filled += 1;
    };

    var jobKey = function (r) {
      return String(r.company || '').trim().toLowerCase() + '|'
           + String(r.jobTitle || '').trim().toLowerCase();
    };
    if ((fields.employmentHistory || []).length) {
      mergeRows('experience', fields.employmentHistory.map(function (e) {
        return { company: e.company || '', jobTitle: e.title || '', location: '',
                 /* The period belongs under "Dates / type", not under
                    "What you did" - a date range is not a duty. */
                 employmentType: e.period || '', responsibilities: '' };
      }), jobKey);
    } else if (fields.currentCompany || fields.title) {
      mergeRows('experience', [{ company: fields.currentCompany || '',
                                 jobTitle: fields.title || '', location: '',
                                 employmentType: '', responsibilities: '' }], jobKey);
    }

    /* The parser gives a qualification, not rows. One row is seeded from
       it; the candidate adds the rest. A row is NOT created from the
       loose education text alone - that produced a row with every column
       blank, which the candidate then had to delete. */
    if (fields.qualification) {
      mergeRows('education', [{ qualification: fields.qualification,
                                specialization: '', institution: '',
                                passingYear: '', score: '', educationType: '' }],
        function (r) {
          return String(r.qualification || '').trim().toLowerCase() + '|'
               + String(r.institution || '').trim().toLowerCase();
        });
    }

    /* NOT step 3. See the header. */
    return filled;
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
    el.innerHTML = S.mode === 'modal' ? modalHtml(c) : wizardHtml(c);
  }

  function modalHtml(c) {
    return '<div class="tlpo-ov" onclick="tlpoBackdrop(event)">'
      + '<div class="tlpo-card tlpo-modal" role="dialog" aria-modal="true" aria-labelledby="tlpoTitle">'
      +   '<div class="tlpo-modal-top">'
      +     ring(completion(c), 76)
      +     '<div><h2 id="tlpoTitle">Build your profile</h2>'
      +       '<p>Add your resume and details to get better job matches.</p></div>'
      +   '</div>'
      +   '<div class="tlpo-acts">'
      +     '<button class="tlpo-btn ghost" onclick="tlpoLater()">Later</button>'
      +     '<button class="tlpo-btn pri" onclick="tlpoStart()">OK</button>'
      +   '</div>'
      + '</div></div>';
  }

  /* ---- small pieces ------------------------------------------------- */
  function field(label, inner, hint) {
    return '<div class="tlpo-f"><label class="tlpo-l">' + esc(label) + '</label>'
      + inner + (hint ? '<span class="tlpo-hint">' + esc(hint) + '</span>' : '') + '</div>';
  }

  function chips(kind, list, placeholder) {
    return '<div class="tlpo-chips" id="tlpoChips_' + kind + '">'
      + list.map(function (v, i) {
          return '<span class="tlpo-chip">' + esc(v)
            + '<button type="button" aria-label="Remove" '
            + 'onclick="tlpoChipRemove(\'' + kind + '\',' + i + ')">✕</button></span>';
        }).join('')
      + '<input class="tlpo-chipin" id="tlpoChipIn_' + kind + '" placeholder="'
      + esc(placeholder) + '" onkeydown="tlpoChipKey(event,\'' + kind + '\')" '
      + 'onblur="tlpoChipAdd(\'' + kind + '\')">'
      + '</div>';
  }

  function rowsBlock(kind, rows, cols, noun) {
    return '<div class="tlpo-rows">'
      + rows.map(function (r, i) {
          return '<div class="tlpo-row">'
            + '<button class="tlpo-rowx" type="button" aria-label="Remove" '
            +   'onclick="tlpoRowRemove(\'' + kind + '\',' + i + ')">✕</button>'
            + cols.map(function (col) {
                var v = r[col[0]] == null ? '' : r[col[0]];
                return '<div class="tlpo-f' + (col[2] === 'wide' ? ' wide' : '') + '">'
                  + '<label class="tlpo-l">' + esc(col[1]) + '</label>'
                  + (col[2] === 'wide'
                    ? '<textarea class="tlpo-i tlpo-ta" rows="2" '
                      + 'oninput="tlpoRowSet(\'' + kind + '\',' + i + ',\'' + col[0] + '\',this.value)">'
                      + esc(v) + '</textarea>'
                    : '<input class="tlpo-i" value="' + esc(v) + '" '
                      + 'oninput="tlpoRowSet(\'' + kind + '\',' + i + ',\'' + col[0] + '\',this.value)">')
                  + '</div>';
              }).join('')
            + '</div>';
        }).join('')
      + '<button class="tlpo-add" type="button" onclick="tlpoRowAdd(\'' + kind + '\')">'
      + '+ ' + esc((rows.length ? 'Add another ' : 'Add a ') + noun) + '</button></div>';
  }

  /* ---- step 1 ------------------------------------------------------- */
  function stepResume(c) {
    var status = '';
    if (S.parseState === 'uploading') status = 'Resume uploaded';
    else if (S.parseState === 'reading') status = 'Extracting profile information…';
    else if (S.parseState === 'done') {
      status = S.parsedCount
        ? 'Profile information extracted — ' + S.parsedCount
          + ' section' + (S.parsedCount === 1 ? '' : 's') + ' filled in for you'
        : 'We could not read anything useful from that file — you can fill '
          + 'the next steps in yourself';
    } else if (S.parseState === 'failed') status = '';

    return '<div class="tlpo-drop" id="tlpoDrop" '
      +   'ondragover="tlpoDrag(event,1)" ondragleave="tlpoDrag(event,0)" ondrop="tlpoDrop(event)">'
      +   '<div class="tlpo-drop-ic">📄</div>'
      +   '<b>Drop your CV here</b>'
      +   '<span>PDF, DOC or DOCX · up to 5 MB</span>'
      +   '<input type="file" id="tlpoFile" accept=".pdf,.doc,.docx" '
      +     'style="display:none" onchange="tlpoPicked(this)">'
      +   '<button class="tlpo-btn ghost sm" type="button" '
      +     'onclick="document.getElementById(\'tlpoFile\').click()">Browse</button>'
      +   (S.resumeName ? '<div class="tlpo-file">' + esc(S.resumeName) + '</div>' : '')
      +   (c.resumeFile && !S.resumeName
            ? '<div class="tlpo-file">Already on file: ' + esc(c.resumeFile) + '</div>' : '')
      + '</div>'
      + (S.saving ? '<div class="tlpo-bar"><i></i></div>' : '')
      + (status ? '<div class="tlpo-status">' + esc(status) + '</div>' : '')
      + '<div class="tlpo-note">We read it to fill in the next step. Anything it gets '
      + 'wrong, you can change there — and you can skip this and type it all in.</div>';
  }

  /* ---- step 2 ------------------------------------------------------- */
  function stepReview() {
    var f = S.form;
    /* Saying "we picked these up from your resume" to somebody who
       skipped the upload is a claim about work we did not do. */
    var note = S.parsedCount > 0
      ? 'We picked these up from your resume — feel free to edit before saving.'
      : 'Fill in what you can. Nothing here is compulsory, and you can come '
        + 'back to it later.';
    return '<div class="tlpo-note tlpo-picked">' + esc(note) + '</div>'

      + '<h3 class="tlpo-h">Personal information</h3>'
      + '<div class="tlpo-grid">'
      +   field('Full name', '<input class="tlpo-i" value="' + esc(f.name) + '" '
      +     'oninput="tlpoSet(\'name\',this.value)">')
      +   field('Email', '<input class="tlpo-i" value="' + esc(f.email) + '" '
      +     'oninput="tlpoSet(\'email\',this.value)">')
      +   field('Phone', '<input class="tlpo-i" value="' + esc(f.phone) + '" '
      +     'oninput="tlpoSet(\'phone\',this.value)">')
      +   field('City', '<input class="tlpo-i" value="' + esc(f.location) + '" '
      +     'oninput="tlpoSet(\'location\',this.value)">')
      + '</div>'

      + '<h3 class="tlpo-h">Profile summary</h3>'
      + '<textarea class="tlpo-i tlpo-ta" rows="4" '
      +   'oninput="tlpoSet(\'summary\',this.value)">' + esc(f.summary) + '</textarea>'

      + '<h3 class="tlpo-h">Work experience</h3>'
      + rowsBlock('experience', f.experience, [
          ['company', 'Company'], ['jobTitle', 'Job title'],
          ['location', 'Location'], ['employmentType', 'Dates / type'],
          ['responsibilities', 'What you did', 'wide'],
        ], 'job')

      + '<h3 class="tlpo-h">Education</h3>'
      + rowsBlock('education', f.education, [
          ['qualification', 'Qualification'], ['specialization', 'Field of study'],
          ['institution', 'Institution'], ['passingYear', 'Year'],
          ['score', 'Grade / %'],
        ], 'qualification')

      + '<h3 class="tlpo-h">Key skills</h3>'
      + chips('skills', f.skills, 'Type a skill and press Enter')

      + '<h3 class="tlpo-h">Certifications</h3>'
      + chips('certifications', f.certifications, 'Type a certification and press Enter')

      + '<h3 class="tlpo-h">Projects</h3>'
      + rowsBlock('projects', f.projects, [
          ['name', 'Project'], ['description', 'What it was', 'wide'],
        ], 'project')

      + '<h3 class="tlpo-h">Languages</h3>'
      + chips('languages', f.languages, 'Type a language and press Enter');
  }

  /* ---- step 3 ------------------------------------------------------- */
  function stepDetails() {
    var f = S.form;
    return '<div class="tlpo-note">These five decide which jobs you are shown and what '
      +   'a recruiter says on your behalf, so we ask rather than guess.</div>'

      + field('Notice period *',
          '<select class="tlpo-i" id="tlpo_notice" onchange="tlpoSet(\'noticePeriod\',this.value)">'
          + '<option value="">Select…</option>'
          + NOTICE.map(function (n) {
              return '<option value="' + esc(n) + '"'
                + (f.noticePeriod === n ? ' selected' : '') + '>' + esc(n) + '</option>';
            }).join('')
          + '</select>')

      + field('Current location *',
          '<input class="tlpo-i" id="tlpo_curloc" value="' + esc(f.currentLocation) + '" '
          + 'placeholder="e.g. Hyderabad" oninput="tlpoSet(\'currentLocation\',this.value)">')

      + field('Preferred locations *', chips('preferredLocations', f.preferredLocations,
          'Type a city and press Enter'))

      + field('Preferred roles *', chips('preferredRoles', f.preferredRoles,
          'Type a role and press Enter'))

      + field('Expected salary *',
          '<div class="tlpo-money">'
          + '<span class="tlpo-cur">₹</span>'
          + '<input class="tlpo-i" id="tlpo_sal" type="number" min="0" step="0.1" '
          +   'value="' + esc(f.salaryAmount) + '" placeholder="e.g. 4.5" '
          +   'oninput="tlpoSet(\'salaryAmount\',this.value)">'
          + '<select class="tlpo-i tlpo-unit" onchange="tlpoSet(\'salaryUnit\',this.value)">'
          +   '<option value="year"' + (f.salaryUnit === 'year' ? ' selected' : '') + '>'
          +     'lakh per annum</option>'
          +   '<option value="month"' + (f.salaryUnit === 'month' ? ' selected' : '') + '>'
          +     'per month</option>'
          + '</select></div>');
  }

  function wizardHtml(c) {
    var last = S.step === STEPS.length - 1;
    return '<div class="tlpo-ov" onclick="tlpoBackdrop(event)">'
      + '<div class="tlpo-card tlpo-wiz" role="dialog" aria-modal="true">'
      +   '<div class="tlpo-head">'
      +     '<div><div class="tlpo-step">Step ' + (S.step + 1) + ' of ' + STEPS.length + '</div>'
      +       '<h2>' + esc(STEPS[S.step]) + '</h2></div>'
      +     ring(completion(c), 52)
      +     '<button class="tlpo-x" onclick="tlpoClose()" aria-label="Close and finish later">'
      +       '✕</button>'
      +   '</div>'
      +   '<div class="tlpo-dots">'
      +     STEPS.map(function (s, i) {
            return '<i class="' + (i < S.step ? 'done' : i === S.step ? 'on' : '') + '"></i>';
          }).join('')
      +   '</div>'
      +   '<div class="tlpo-body">'
      +     (S.error ? '<div class="tlpo-err" role="alert">' + esc(S.error) + '</div>' : '')
      +     (S.step === 0 ? stepResume(c) : S.step === 1 ? stepReview() : stepDetails())
      +   '</div>'
      +   '<div class="tlpo-acts">'
      +     (S.step > 0
            ? '<button class="tlpo-btn ghost" onclick="tlpoBack()"'
              + (S.saving ? ' disabled' : '') + '>Back</button>' : '')
      +     (S.step === 0
            ? '<button class="tlpo-skip" onclick="tlpoNext()"' + (S.saving ? ' disabled' : '')
              + '>Skip this step</button>' : '')
      +     '<button class="tlpo-btn pri" onclick="tlpoNext()"' + (S.saving ? ' disabled' : '')
      +       '>' + (S.saving ? 'Saving…' : last ? 'Save and Continue' : 'Continue')
      +     '</button>'
      +   '</div>'
      +   '<div class="tlpo-foot">You can close this and pick up where you left off.</div>'
      + '</div></div>';
  }

  /* ------------------------------------------------------------------ *
   * editing
   * ------------------------------------------------------------------ */
  window.tlpoSet = function (key, v) {
    if (!S.form) return;
    S.form[key] = v;
    /*
     * ONE CITY, ASKED IN TWO PLACES.
     *
     * Step 2 shows "City" as part of what was read from the CV; step 3
     * asks for "Current location" because it is one of the five that
     * decide which jobs are shown. They are the same column, and the
     * save reads step 3's - so a candidate who corrected the city on
     * step 2 watched their correction disappear. Whichever they type in
     * is the answer, and the other shows it too.
     */
    if (key === 'location') S.form.currentLocation = v;
    else if (key === 'currentLocation') S.form.location = v;
  };

  window.tlpoRowSet = function (kind, i, key, v) {
    if (S.form && S.form[kind] && S.form[kind][i]) S.form[kind][i][key] = v;
  };
  window.tlpoRowAdd = function (kind) {
    if (!S.form) return;
    var blanks = {
      experience: { company: '', jobTitle: '', location: '', employmentType: '',
                    responsibilities: '' },
      education: { qualification: '', specialization: '', institution: '',
                   passingYear: '', score: '', educationType: '' },
      projects: { name: '', description: '' },
    };
    S.form[kind].push(JSON.parse(JSON.stringify(blanks[kind] || {})));
    paint();
  };
  window.tlpoRowRemove = function (kind, i) {
    if (S.form && S.form[kind]) { S.form[kind].splice(i, 1); paint(); }
  };

  window.tlpoChipAdd = function (kind) {
    var box = document.getElementById('tlpoChipIn_' + kind);
    if (!box || !S.form) return;
    var v = String(box.value || '').trim().replace(/,+$/, '');
    if (!v) return;
    if (S.form[kind].indexOf(v) < 0) S.form[kind].push(v);
    box.value = '';
    paint();
    var again = document.getElementById('tlpoChipIn_' + kind);
    if (again) { try { again.focus(); } catch (e) {} }
  };
  window.tlpoChipKey = function (ev, kind) {
    if (ev.key === 'Enter' || ev.key === ',') { ev.preventDefault(); window.tlpoChipAdd(kind); }
    else if (ev.key === 'Backspace' && !ev.target.value && S.form && S.form[kind].length) {
      S.form[kind].pop(); paint();
      var again = document.getElementById('tlpoChipIn_' + kind);
      if (again) { try { again.focus(); } catch (e) {} }
    }
  };
  window.tlpoChipRemove = function (kind, i) {
    if (S.form && S.form[kind]) { S.form[kind].splice(i, 1); paint(); }
  };

  /* ------------------------------------------------------------------ *
   * the flow
   * ------------------------------------------------------------------ */
  window.tlpoBackdrop = function (ev) {
    if (ev && ev.target && ev.target.classList && ev.target.classList.contains('tlpo-ov')) {
      if (S.mode === 'modal') window.tlpoLater(); else window.tlpoClose();
    }
  };

  window.tlpoStart = function (step) {
    var c = me();
    if (!c) return;
    S.mode = 'wizard';
    if (!S.form) {
      /* The record as it stands BEFORE any upload. Step 3 reads from
         this and never from the parse. */
      S.before = JSON.parse(JSON.stringify(c));
      S.form = blankForm(c);
    }
    if (typeof step === 'number') S.step = Math.max(0, Math.min(STEPS.length - 1, step));
    S.error = '';
    paint();
  };

  window.tlpoClose = function () {
    S.mode = null; S.error = '';
    paint();
    if (typeof window.render === 'function') window.render();
  };

  window.tlpoLater = function () {
    var c = me();
    S.mode = null;
    paint();
    var a = api();
    if (a && c) {
      a.post('/candidates/' + encodeURIComponent(c.id) + '/onboarding-later', {})
        .then(function (res) { try { c.onboardingLaterCount = res.laterCount; } catch (e) {} })
        .catch(function () { /* never worth interrupting them over */ });
    }
    if (typeof window.render === 'function') window.render();
  };

  window.tlpoBack = function () {
    if (S.saving || S.step === 0) return;
    S.step -= 1; S.error = ''; paint();
  };

  /* ---- the resume step ---------------------------------------------- */
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
    if (file.size > MAX_RESUME_BYTES) {
      S.error = 'That file is ' + (file.size / 1048576).toFixed(1) + ' MB. The limit is 5 MB.';
      paint(); return;
    }

    var c = me();
    var a = api();
    if (!c || !a) { S.error = 'The server could not be reached.'; paint(); return; }

    S.error = ''; S.resumeName = name; S.saving = true; S.parseState = 'uploading';
    paint();
    setTimeout(function () { if (S.saving) { S.parseState = 'reading'; paint(); } }, 400);

    var fd = new FormData();
    fd.append('resume', file);
    fd.append('candidateId', c.id);

    a.post('/uploads/resume', fd, { timeout: 60000 })
      .then(function (res) {
        S.saving = false;
        adopt(res.candidate);
        /* Straight from the parser, so the review step shows what was
           read rather than only what happened to land in a blank
           column. */
        var fields = (res.parse && res.parse.ok && res.parse.fields) || null;
        S.parsedCount = adoptParse(fields);
        S.parseState = 'done';
        paint();
      })
      .catch(function (err) {
        S.saving = false; S.resumeName = ''; S.parseState = 'failed';
        /* NEVER A DEAD END. The upload failing is a reason to type it in,
           not a reason to be stuck on step one. */
        S.error = ((err && err.message) || 'The upload did not go through.')
          + ' You can carry on and fill the next steps in yourself.';
        paint();
      });
  }

  /* ---- moving on ----------------------------------------------------- */
  window.tlpoNext = function () {
    if (S.saving) return;
    S.error = '';

    if (S.step < STEPS.length - 1) { S.step += 1; paint(); return; }

    /* Step 3 is the only one with required fields, and they are required
       because nothing else can supply them. */
    var f = S.form;
    var missing = [];
    if (!f.noticePeriod) missing.push('notice period');
    if (!String(f.currentLocation || '').trim()) missing.push('current location');
    if (!f.preferredLocations.length) missing.push('preferred location');
    if (!f.preferredRoles.length) missing.push('preferred role');
    if (!String(f.salaryAmount || '').trim()) missing.push('expected salary');
    if (missing.length) {
      S.error = 'Still needed: ' + missing.join(', ') + '.';
      paint(); return;
    }

    save();
  };

  function save() {
    var c = me();
    var a = api();
    if (!c || !a) { S.error = 'The server could not be reached.'; paint(); return; }
    var f = S.form;

    S.saving = true; S.error = '';
    paint();

    /* Lakhs per annum is what the column holds and what every screen
       reads; a monthly figure is converted rather than stored in a
       different unit under the same name. */
    var amount = Number(f.salaryAmount);
    var expectedCtc = Number.isFinite(amount)
      ? (f.salaryUnit === 'month' ? Math.round((amount * 12 / 100000) * 100) / 100 : amount)
      : undefined;

    var body = {
      name: String(f.name || '').trim() || undefined,
      phone: String(f.phone || '').trim() || undefined,
      location: String(f.currentLocation || '').trim() || undefined,
      summary: String(f.summary || '').trim() || undefined,
      skills: f.skills,
      certifications: f.certifications,
      languages: f.languages,
      noticePeriod: f.noticePeriod,
      preferredLocation: f.preferredLocations.join(', '),
      preferredRole: f.preferredRoles.join(', '),
      educationRecords: f.education,
      experienceRecords: f.experience,
    };
    if (expectedCtc !== undefined) body.expectedCtc = expectedCtc;

    /* Everything in one call, which is what "Save and Continue" says it
       does. A half-saved profile is worse than a failed one, because the
       candidate is told it worked. */
    a.put('/candidates/' + encodeURIComponent(c.id), body)
      .then(function (res) {
        S.saving = false;
        adopt(res.candidate || res);
        var pct = completion(me());
        S.mode = null; S.step = 0; S.form = null;
        paint();
        toast(pct >= 100
          ? '✓ Saved — your profile is complete.'
          : '✓ Saved — your profile is ' + pct + '% complete.', '✅');
        if (typeof window.navigate === 'function') window.navigate('/candidate/profile');
        else if (typeof window.render === 'function') window.render();
      })
      .catch(function (err) {
        /* NOTHING IS LOST. S.form is untouched, so they press the button
           again rather than typing it all a second time. */
        S.saving = false;
        S.error = ((err && err.message) || 'That did not save.') + ' Nothing was lost — '
          + 'press Save and Continue to try again.';
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
   * the banner, for when the modal has had its three goes
   * ------------------------------------------------------------------ */
  window.tlpoBannerHide = function () {
    S.bannerHidden = true;
    var b = document.getElementById('tlpoBanner');
    if (b) b.remove();
  };

  function bannerHtml(c) {
    return '<div class="tlpo-banner" id="tlpoBanner">'
      + ring(completion(c), 44)
      + '<div class="tlpo-banner-t"><b>Build your profile</b>'
      +   '<span>Add your resume and details to get better job matches.</span></div>'
      + '<button class="tlpo-btn pri sm" onclick="tlpoStart()">Continue</button>'
      + '<button class="tlpo-x sm" onclick="tlpoBannerHide()" aria-label="Hide">✕</button>'
      + '</div>';
  }

  function placeBanner(c) {
    if (S.bannerHidden) return;
    if (document.getElementById('tlpoBanner')) return;
    if (!/^#\/candidate\//.test(location.hash || '')) return;

    var app = document.getElementById('app');
    if (!app) return;
    var el = document.createElement('div');
    el.innerHTML = bannerHtml(c);
    var node = el.firstChild;

    /*
     * UNDER THE HEADER, NEVER ABOVE IT.
     *
     * The candidate shell has none of .cap-wrap / .cap-main / .wrap, so
     * this fell back to the first child of #app - which is ABOVE the
     * sticky header. Measured on Applications at 375px: the header sat
     * 153px down the page behind a 137px banner, and looked as if it did
     * not stick at all. Where the shell has a header, the banner follows
     * it.
     */
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

    /* BUILT IS BUILT. Nothing appears again. */
    if (built(c)) return;

    var h = String(location.hash || '');
    if (/reset-password|forgot-password/.test(h)) return;
    if (location.pathname === '/reset-password') return;

    var later = Number(c.onboardingLaterCount || 0);

    if (later < LATER_LIMIT) {
      if (S.askedThisVisit || S.mode) return;
      S.askedThisVisit = true;
      S.mode = 'modal';
      paint();
      return;
    }
    placeBanner(c);
  }

  /* ------------------------------------------------------------------ *
   * wiring
   * ------------------------------------------------------------------ */
  window.tlpoStartAt = function (fieldKey) {
    var k = String(fieldKey || '');
    var step = k === 'resumeFile' ? 0
      : (k === 'preferredLocation' || k === 'expectedCtc' || k === 'noticePeriod') ? 2 : 1;
    window.tlpoStart(step);
  };

  var originalRender = window.render;
  if (typeof originalRender === 'function') {
    window.render = function () {
      var out = originalRender.apply(this, arguments);
      setTimeout(function () { try { consider(); } catch (e) {} }, 0);
      return out;
    };
  }

  var originalSubmitLogin = window.submitLogin;
  if (typeof originalSubmitLogin === 'function') {
    window.submitLogin = function () {
      S.askedThisVisit = false;
      S.bannerHidden = false;
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
