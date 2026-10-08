/*
 * TeamLink — the candidate profile, complete and honest about it.
 *
 * Adds to the existing Profile page (capProfile in index.html), using
 * its own card markup and form classes; nothing is redesigned:
 *
 *   sections   Projects, Internships / Training, Achievements,
 *              Professional links, Availability, Additional information -
 *              each a card with an inline editor like the others. Stored
 *              on the candidate (0087 + the existing projects / links /
 *              availability columns).
 *   score      Profile completion from TWELVE sections of the saved
 *              record. 100% only when every one is complete; a resume
 *              upload on its own completes "Resume" and nothing else.
 *              Click the percentage for the breakdown and a "Complete
 *              profile" button that opens the first missing section.
 *   resume     Upload -> "Extracting profile information…" -> "N profile
 *              fields were filled from your resume". Where the resume
 *              says something different from what the candidate already
 *              entered, it is offered for review, never written silently.
 *   saving     The existing inline editors changed only the page's copy
 *              of the profile, so an edit was gone after a refresh. They
 *              now save to the server like the new sections do.
 */
(function () {
  'use strict';

  var api = function () { return window.TL && TL.api; };
  var cand = function () {
    return (window.STATE && STATE.session && STATE.session.role === 'candidate' && window.DATA && DATA.candidateById)
      ? DATA.candidateById(STATE.session.id) : null;
  };
  var h = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  };
  var say = function (m, i) { if (typeof window.toast === 'function') toast(m, i || '✓'); };
  var rerender = function () { if (typeof window.render === 'function') render(); };
  var nonEmpty = function (v) { return v != null && String(v).trim() !== ''; };
  var list = function (v) { return Array.isArray(v) ? v : []; };

  /* ------------------------------------------------------------------ *
   * 1. the twelve sections and the score
   * ------------------------------------------------------------------ */

  /* 0117: the server works out the same twelve sections, with the same
     rules, in api/src/profile/completeness.js (GET /api/me/profile-completeness,
     and the registration's "Profile Completeness"). Change a rule in both. */
  var SECTIONS = [
    ['basic', 'Basic details', function (c) { return nonEmpty(c.name) && nonEmpty(c.email) && nonEmpty(c.phone) && nonEmpty(c.location); }, 'Basic details'],
    ['summary', 'Profile summary', function (c) { return String(c.summary || '').trim().length >= 20; }, 'Profile summary'],
    ['education', 'Education', function (c) { return list(c.educationRecords).length > 0 || nonEmpty(c.education); }, 'Education'],
    ['skills', 'Key skills', function (c) {
      var all = {}; list(c.skills).concat(list(c.technicalSkills)).forEach(function (s) { if (nonEmpty(s)) all[String(s).toLowerCase()] = 1; });
      return Object.keys(all).length >= 3;
    }, 'Key skills'],
    ['projects', 'Projects', function (c) { return list(c.projects).some(function (p) { return p && nonEmpty(p.name); }); }, 'Projects'],
    ['employment', 'Internships / employment', function (c) {
      return list(c.experienceRecords).length > 0 || nonEmpty(c.currentCompany)
        || list(c.internships).some(function (x) { return x && (nonEmpty(x.role) || nonEmpty(x.org)); });
    }, 'Employment'],
    ['certifications', 'Certifications', function (c) { return list(c.certifications).length > 0; }, 'Certifications'],
    ['languages', 'Languages', function (c) { return list(c.languages).length > 0; }, 'Languages'],
    ['career', 'Career preferences', function (c) {
      return nonEmpty(c.preferredRole || c.title) && nonEmpty(c.preferredLocation) && nonEmpty(c.noticePeriod)
        && Number(c.expectedCtc) > 0 && list(c.preferredWorkModes).length > 0;
    }, 'Career preferences'],
    ['availability', 'Availability', function (c) {
      return (c.immediateJoiner === true || nonEmpty(c.availableFrom) || nonEmpty(c.preferredJoiningDate))
        && (c.willingToRelocate === true || c.willingToRelocate === false);
    }, 'Availability'],
    ['resume', 'Resume', function (c) { return nonEmpty(c.resumeFile); }, 'Resume'],
    ['links', 'Professional links', function (c) {
      return nonEmpty(c.linkedin) || nonEmpty(c.github) || nonEmpty(c.portfolio)
        || list(c.otherLinks).some(function (l) { return l && nonEmpty(l.url); });
    }, 'Professional links'],
  ];

  /* Same shape as before - [key, label, test] - so every caller keeps working. */
  window.capMissing = function (c) {
    if (!c) return [];
    return SECTIONS.filter(function (s) { return !s[2](c); }).map(function (s) { return [s[0], s[1], s[2]]; });
  };
  window.capCompletion = function (c) {
    if (!c) return 0;
    var done = SECTIONS.length - window.capMissing(c).length;
    /* Rounding must never turn "eleven of twelve" into 100. */
    var pct = Math.round(100 * done / SECTIONS.length);
    return done < SECTIONS.length ? Math.min(pct, 99) : 100;
  };
  window.capSections = function (c) {
    return SECTIONS.map(function (s) { return { key: s[0], label: s[1], done: !!(c && s[2](c)), card: s[3] }; });
  };

  window.tlpsBreakdown = function () {
    var c = cand(); if (!c || typeof window.fcrModal !== 'function') return;
    var rows = window.capSections(c);
    var done = rows.filter(function (r) { return r.done; }).length;
    var pct = window.capCompletion(c);
    fcrModal('<div class="fcr-jd-head"><h3>Profile completion: ' + pct + '%</h3>'
      + '<p>' + done + ' of ' + rows.length + ' sections complete. Worked out from what is saved on your profile.</p>'
      + '<button class="fcr-jd-x" onclick="fcrCloseModal()">✕</button></div>'
      + '<div class="fcr-jd-body"><div style="display:grid;grid-template-columns:1fr auto;gap:7px 16px;font-size:13px">'
      + rows.map(function (r) {
        return '<div style="color:#26313f">' + h(r.label) + '</div>'
          + '<div style="font-weight:800;color:' + (r.done ? '#0f7a44' : '#b4292b') + '">' + (r.done ? '✓' : '✗ Missing') + '</div>';
      }).join('') + '</div></div>'
      + '<div class="fcr-jd-actions">'
      + (done < rows.length ? '<button class="btn btn-primary" onclick="tlpsCompleteNext()">Complete profile</button>' : '')
      + '<button class="btn btn-ghost" onclick="fcrCloseModal()">Close</button></div>');
  };

  /** Take the candidate to the first missing section, with its editor open. */
  var EDITOR = { basic: 'basic', summary: 'summary', education: 'education', skills: 'skills',
    certifications: 'certifications', languages: 'languages', career: 'career' };
  var MINE = { projects: 'projects', employment: 'internships', availability: 'availability', links: 'links' };
  window.tlpsCompleteNext = function () {
    var c = cand(); if (!c) return;
    if (typeof window.fcrCloseModal === 'function') fcrCloseModal();
    var miss = window.capSections(c).filter(function (r) { return !r.done; })[0];
    if (!miss) return;
    if (miss.key === 'resume') { location.hash = '#/candidate/resume'; return; }
    if (location.hash.indexOf('#/candidate/profile') !== 0) location.hash = '#/candidate/profile';
    setTimeout(function () {
      if (MINE[miss.key]) window.tlpsEdit(MINE[miss.key]);
      else if (EDITOR[miss.key] && typeof window.capEditOpen === 'function') capEditOpen(EDITOR[miss.key]);
      setTimeout(function () {
        var title = miss.key === 'employment' ? 'Internships / Training' : miss.card;
        var head = Array.prototype.filter.call(document.querySelectorAll('.cap-bh h4'), function (x) {
          return x.textContent.trim() === title;
        })[0];
        if (head) head.closest('.cap-card').scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 120);
    }, 200);
  };

  /* ------------------------------------------------------------------ *
   * 2. saving to the server
   * ------------------------------------------------------------------ */

  function save(fields, msg) {
    var c = cand();
    if (!c || !api()) return Promise.reject(new Error('Not signed in'));
    return api().put('/candidates/' + encodeURIComponent(c.id), fields).then(function (r) {
      if (r && r.candidate) Object.assign(c, r.candidate);
      if (msg) say(msg, '✓');
      rerender();
      return r;
    });
  }

  /* The existing inline editors, saved for real. */
  var EDITABLE = ['name', 'title', 'location', 'exp', 'phone', 'preferredRole', 'preferredLocation',
    'noticePeriod', 'expectedCtc', 'preferredWorkModes', 'summary', 'education', 'skills',
    'technicalSkills', 'languages', 'certifications', 'currentCompany', 'previousCompanies'];
  function wrapInlineSave() {
    var prev = window.capEditSave;
    if (typeof prev !== 'function' || prev.__tlps) return;
    var next = function () {
      var c = cand();
      var before = c ? JSON.stringify(EDITABLE.map(function (k) { return c[k]; })) : null;
      var snap = c ? EDITABLE.reduce(function (o, k) { o[k] = c[k]; return o; }, {}) : {};
      var out = prev.apply(this, arguments);
      try {
        c = cand();
        if (c && before !== JSON.stringify(EDITABLE.map(function (k) { return c[k]; }))) {
          var body = {};
          EDITABLE.forEach(function (k) {
            if (JSON.stringify(c[k]) === JSON.stringify(snap[k])) return;
            var v = c[k];
            if (k === 'expectedCtc') { v = Number(v); if (!isFinite(v)) return; }
            if (Array.isArray(snap[k]) || ['skills', 'technicalSkills', 'languages', 'certifications', 'previousCompanies', 'preferredWorkModes'].indexOf(k) >= 0) {
              v = list(v).map(String);
            } else if (k !== 'expectedCtc') v = v == null ? '' : String(v);
            body[k] = v;
          });
          if (Object.keys(body).length) {
            api().put('/candidates/' + encodeURIComponent(c.id), body).then(function (r) {
              var local = cand(); if (local && r && r.candidate) Object.assign(local, r.candidate);
              rerender();
            }).catch(function (err) {
              say((err && err.message) || 'That change could not be saved. Please try again.', '⚠️');
            });
          }
        }
      } catch (e) { /* the screen already shows the edit */ }
      return out;
    };
    next.__tlps = true;
    window.capEditSave = next;
  }

  /* ------------------------------------------------------------------ *
   * 3. the new cards and their editors
   * ------------------------------------------------------------------ */

  STATE.tlps = STATE.tlps || { open: '', draft: null, err: '' };

  var pen = function (sec, title) {
    return '<button class="cap-pen' + (STATE.tlps.open === sec ? ' on' : '') + '" title="Edit ' + h(title)
      + '" onclick="tlpsEdit(\'' + sec + '\')">✎</button>';
  };
  var card = function (sec, title, inner) {
    return '<div class="cap-card cap-block" data-tlps="' + sec + '"><div class="cap-bh"><h4>' + h(title) + '</h4>'
      + pen(sec, title) + '</div>' + (STATE.tlps.open === sec ? formHtml(sec) : inner) + '</div>';
  };
  var row = function (title, sub, text) {
    return '<div style="padding:7px 0;border-top:1px solid #eef1f5">'
      + '<div style="font-size:12.5px;font-weight:700;color:#243449">' + title + '</div>'
      + (sub ? '<div style="font-size:11.5px;color:#6b7a90;margin-top:2px">' + sub + '</div>' : '')
      + (text ? '<div style="font-size:12px;color:#42505f;line-height:1.55;margin-top:3px">' + h(text) + '</div>' : '')
      + '</div>';
  };
  var link = function (u) {
    var safe = /^https?:\/\//i.test(u) ? u : 'https://' + u;
    return '<a href="' + h(safe) + '" target="_blank" rel="noopener noreferrer" style="color:var(--cap-blue,#1d6ff2);font-weight:700;word-break:break-all">' + h(u) + '</a>';
  };

  function cardsHtml(c) {
    var p = list(c.projects).filter(function (x) { return x && nonEmpty(x.name); });
    var it = list(c.internships).filter(function (x) { return x && (nonEmpty(x.role) || nonEmpty(x.org)); });
    var ac = list(c.achievements).filter(function (x) { return x && nonEmpty(x.title); });
    var links = [['LinkedIn', c.linkedin], ['GitHub', c.github], ['Portfolio', c.portfolio]]
      .concat(list(c.otherLinks).map(function (l) { return [l.label || 'Link', l.url]; }))
      .filter(function (l) { return nonEmpty(l[1]); });
    var yn = c.willingToRelocate === true ? 'Yes' : c.willingToRelocate === false ? 'No' : '—';
    return ''
      + card('internships', 'Internships / Training', it.length ? it.map(function (x) {
        return row(h(x.role || 'Internship') + (x.org ? ' <span style="font-weight:500;color:#6b7a90">at ' + h(x.org) + '</span>' : ''),
          [x.duration, x.tech].filter(nonEmpty).map(h).join(' &middot; '), x.desc);
      }).join('') : '<div class="cap-empty">No internships or training added yet.</div>')
      + card('projects', 'Projects', p.length ? p.map(function (x) {
        return row(h(x.name) + (x.role ? ' <span style="font-weight:500;color:#6b7a90">&middot; ' + h(x.role) + '</span>' : ''),
          [x.tech ? h(x.tech) : '', x.url ? link(x.url) : ''].filter(Boolean).join(' &middot; '), x.desc);
      }).join('') : '<div class="cap-empty">No projects added yet.</div>')
      + card('achievements', 'Achievements', ac.length ? ac.map(function (x) {
        return row(h(x.title), [x.org, x.date].filter(nonEmpty).map(h).join(' &middot; '), x.desc);
      }).join('') : '<div class="cap-empty">No achievements added yet.</div>')
      + card('links', 'Professional links', links.length ? '<div class="cap-kv">' + links.map(function (l) {
        return '<div class="k">' + h(l[0]) + '</div><div class="v">' + link(l[1]) + '</div>';
      }).join('') + '</div>' : '<div class="cap-empty">Add your LinkedIn, GitHub or portfolio.</div>')
      + card('availability', 'Availability', '<div class="cap-kv">'
        + '<div class="k">Immediate joiner</div><div class="v">' + (c.immediateJoiner ? 'Yes' : 'No') + '</div>'
        + '<div class="k">Available from</div><div class="v">' + h(c.availableFrom || '—') + '</div>'
        + '<div class="k">Preferred joining date</div><div class="v">' + h(c.preferredJoiningDate || '—') + '</div>'
        + '<div class="k">Willing to relocate</div><div class="v">' + yn + (c.relocationLocation ? ' &middot; ' + h(c.relocationLocation) : '') + '</div>'
        + '</div>')
      + card('additional', 'Additional information', nonEmpty(c.additionalInfo)
        ? '<div style="font-size:12.5px;color:#42505f;line-height:1.6;white-space:pre-wrap">' + h(c.additionalInfo) + '</div>'
        : '<div class="cap-empty">Anything else a recruiter should know.</div>');
  }

  /* ---- editors ---- */

  var BLANK = {
    projects: function () { return { name: '', role: '', tech: '', url: '', desc: '' }; },
    internships: function () { return { org: '', role: '', duration: '', tech: '', desc: '' }; },
    achievements: function () { return { title: '', org: '', date: '', desc: '' }; },
    otherLinks: function () { return { label: '', url: '' }; },
  };
  var FIELDS = {
    projects: [['name', 'Project name'], ['role', 'Your role'], ['tech', 'Technologies used'], ['url', 'Project URL'], ['desc', 'Description', 'area']],
    internships: [['org', 'Organization'], ['role', 'Role / training name'], ['duration', 'Duration', '', 'e.g. Jun 2023 – Aug 2023'], ['tech', 'Skills / technologies'], ['desc', 'Description', 'area']],
    achievements: [['title', 'Achievement'], ['org', 'Organization'], ['date', 'Date', '', 'e.g. Mar 2024'], ['desc', 'Description', 'area']],
  };

  window.tlpsEdit = function (sec) {
    var c = cand(); if (!c) return;
    if (STATE.tlps.open === sec) { STATE.tlps = { open: '', draft: null, err: '' }; rerender(); return; }
    var copy = function (a) { return list(a).map(function (x) { return Object.assign({}, x); }); };
    var d = {};
    if (sec === 'projects') d.items = copy(c.projects).map(function (x) { return Object.assign(BLANK.projects(), x); });
    if (sec === 'internships') d.items = copy(c.internships).map(function (x) { return Object.assign(BLANK.internships(), x); });
    if (sec === 'achievements') d.items = copy(c.achievements).map(function (x) { return Object.assign(BLANK.achievements(), x); });
    if (sec === 'links') { d.linkedin = c.linkedin || ''; d.github = c.github || ''; d.portfolio = c.portfolio || ''; d.items = copy(c.otherLinks); }
    if (sec === 'availability') {
      d.availableFrom = c.availableFrom || ''; d.preferredJoiningDate = c.preferredJoiningDate || '';
      d.immediateJoiner = !!c.immediateJoiner; d.willingToRelocate = c.willingToRelocate;
      d.relocationLocation = c.relocationLocation || '';
    }
    if (sec === 'additional') d.additionalInfo = c.additionalInfo || '';
    if (d.items && !d.items.length) d.items.push(sec === 'links' ? BLANK.otherLinks() : BLANK[sec]());
    STATE.tlps = { open: sec, draft: d, err: '' };
    rerender();
  };

  /** Read what is typed back into the draft before any re-render. */
  function pull() {
    var d = STATE.tlps.draft; if (!d) return;
    Array.prototype.forEach.call(document.querySelectorAll('[data-tlps-f]'), function (el) {
      var path = el.getAttribute('data-tlps-f').split('.');
      var v = el.type === 'checkbox' ? el.checked : el.value;
      if (path.length === 1) d[path[0]] = v;
      else if (d.items && d.items[Number(path[1])]) d.items[Number(path[1])][path[2]] = v;
    });
    var rel = document.querySelector('input[name="tlpsRel"]:checked');
    if (rel) d.willingToRelocate = rel.value === 'yes' ? true : rel.value === 'no' ? false : null;
  }
  window.tlpsAdd = function () {
    pull(); var s = STATE.tlps.open; var d = STATE.tlps.draft;
    if (d.items.length >= 20) return;
    d.items.push(s === 'links' ? BLANK.otherLinks() : BLANK[s]());
    rerender();
  };
  window.tlpsRemove = function (i) { pull(); STATE.tlps.draft.items.splice(i, 1); rerender(); };
  window.tlpsCancel = function () { STATE.tlps = { open: '', draft: null, err: '' }; rerender(); };

  var urlOk = function (u) { return !nonEmpty(u) || /^(https?:\/\/)?[^\s.]+\.[^\s]{2,}$/i.test(String(u).trim()); };

  window.tlpsSave = function () {
    pull();
    var s = STATE.tlps.open, d = STATE.tlps.draft, body = {};
    var trimAll = function (o) { var r = {}; Object.keys(o).forEach(function (k) { r[k] = String(o[k] == null ? '' : o[k]).trim(); }); return r; };
    var err = '';
    if (s === 'projects' || s === 'internships' || s === 'achievements') {
      var key = FIELDS[s][0][0];
      var items = d.items.map(trimAll).filter(function (x) {
        return Object.keys(x).some(function (k) { return x[k]; });
      });
      if (items.some(function (x) { return !x[key] && !(s === 'internships' && x.role); })) {
        err = s === 'projects' ? 'Every project needs a name.' : s === 'achievements' ? 'Every achievement needs a title.' : 'Every entry needs an organization or a role.';
      }
      if (s === 'projects' && items.some(function (x) { return !urlOk(x.url); })) err = 'That project URL does not look like a web address.';
      body[s] = items;
    } else if (s === 'links') {
      ['linkedin', 'github', 'portfolio'].forEach(function (k) { body[k] = String(d[k] || '').trim(); });
      body.otherLinks = d.items.map(trimAll).filter(function (x) { return x.url; });
      if (['linkedin', 'github', 'portfolio'].some(function (k) { return !urlOk(body[k]); })
          || body.otherLinks.some(function (x) { return !urlOk(x.url); })) err = 'One of those links does not look like a web address.';
    } else if (s === 'availability') {
      body.immediateJoiner = !!d.immediateJoiner;
      body.availableFrom = d.availableFrom || '';
      body.preferredJoiningDate = d.preferredJoiningDate || '';
      body.willingToRelocate = d.willingToRelocate === true || d.willingToRelocate === false ? d.willingToRelocate : null;
      body.relocationLocation = String(d.relocationLocation || '').trim();
    } else if (s === 'additional') {
      body.additionalInfo = String(d.additionalInfo || '').trim();
    }
    if (err) { STATE.tlps.err = err; rerender(); return; }
    var btn = document.getElementById('tlpsSaveBtn'); if (btn) btn.disabled = true;
    save(body, 'Profile updated').then(function () {
      STATE.tlps = { open: '', draft: null, err: '' };
      rerender();
    }).catch(function (e) {
      STATE.tlps.err = (e && e.message) || 'That could not be saved. Please try again.';
      rerender();
    });
  };

  function formHtml(sec) {
    var d = STATE.tlps.draft || {};
    var f = function (label, inner, hint) {
      return '<div class="cpe-f"><label>' + h(label) + '</label>' + inner + (hint ? '<div class="hint">' + h(hint) + '</div>' : '') + '</div>';
    };
    var input = function (path, v, ph, type) {
      return '<input data-tlps-f="' + path + '" type="' + (type || 'text') + '" value="' + h(v || '') + '" placeholder="' + h(ph || '') + '">';
    };
    var body = '';
    if (FIELDS[sec]) {
      body = d.items.map(function (it, i) {
        var short = FIELDS[sec].filter(function (x) { return x[2] !== 'area'; });
        var area = FIELDS[sec].filter(function (x) { return x[2] === 'area'; });
        return '<div style="border:1px solid #eef1f5;border-radius:10px;padding:10px 12px;margin-bottom:10px">'
          + '<div class="cpe-grid">' + short.map(function (x) {
            return f(x[1], input('items.' + i + '.' + x[0], it[x[0]], x[3] || ''));
          }).join('') + '</div>'
          + area.map(function (x) {
            return f(x[1], '<textarea data-tlps-f="items.' + i + '.' + x[0] + '">' + h(it[x[0]] || '') + '</textarea>');
          }).join('')
          + '<button type="button" class="cpe-cancel" style="padding:5px 12px;font-size:11.5px" onclick="tlpsRemove(' + i + ')">Remove</button>'
          + '</div>';
      }).join('')
        + (d.items.length < 20 ? '<button type="button" class="cpe-cancel" onclick="tlpsAdd()">＋ Add ' + (sec === 'projects' ? 'a project' : sec === 'internships' ? 'an internship or training' : 'an achievement') + '</button>' : '');
    } else if (sec === 'links') {
      body = '<div class="cpe-grid">'
        + f('LinkedIn', input('linkedin', d.linkedin, 'linkedin.com/in/your-name'))
        + f('GitHub', input('github', d.github, 'github.com/your-name'))
        + f('Portfolio', input('portfolio', d.portfolio, 'your-site.com')) + '</div>'
        + '<div class="cpe-f"><label>Other links</label></div>'
        + d.items.map(function (it, i) {
          return '<div class="cpe-grid" style="margin-bottom:6px">'
            + f('Label', input('items.' + i + '.label', it.label, 'e.g. Behance'))
            + f('URL', input('items.' + i + '.url', it.url, 'https://…'))
            + '<div><button type="button" class="cpe-cancel" style="padding:5px 12px;font-size:11.5px" onclick="tlpsRemove(' + i + ')">Remove</button></div></div>';
        }).join('')
        + (d.items.length < 10 ? '<button type="button" class="cpe-cancel" onclick="tlpsAdd()">＋ Add a link</button>' : '');
    } else if (sec === 'availability') {
      var rel = d.willingToRelocate;
      body = '<div class="cpe-grid">'
        + f('Available from', input('availableFrom', d.availableFrom, '', 'date'))
        + f('Preferred joining date', input('preferredJoiningDate', d.preferredJoiningDate, '', 'date')) + '</div>'
        + f('Immediate joiner', '<div class="cpe-modes"><label><input type="checkbox" data-tlps-f="immediateJoiner"' + (d.immediateJoiner ? ' checked' : '') + '>I can join immediately</label></div>')
        + f('Willing to relocate', '<div class="cpe-modes">'
          + [['yes', 'Yes', true], ['no', 'No', false]].map(function (o) {
            return '<label><input type="radio" name="tlpsRel" value="' + o[0] + '"' + (rel === o[2] ? ' checked' : '') + '>' + o[1] + '</label>';
          }).join('') + '</div>')
        + f('Where to (optional)', input('relocationLocation', d.relocationLocation, 'e.g. Bengaluru, Pune'));
    } else if (sec === 'additional') {
      body = f('Additional information', '<textarea data-tlps-f="additionalInfo" maxlength="2000" placeholder="Anything else a recruiter should know">' + h(d.additionalInfo || '') + '</textarea>');
    }
    var err = STATE.tlps.err ? '<div class="err">' + h(STATE.tlps.err) + '</div>' : '';
    return '<div class="cpe-form">' + body + err + '<div class="cpe-act">'
      + '<button class="cpe-save" id="tlpsSaveBtn" onclick="tlpsSave()">Save</button>'
      + '<button class="cpe-cancel" onclick="tlpsCancel()">Cancel</button></div></div>';
  }

  /* ---- placing the cards, and the clickable score ---- */

  function wrapProfile() {
    var prev = window.capProfile;
    if (typeof prev !== 'function' || prev.__tlps) return;
    var next = function () {
      var html = prev.apply(this, arguments);
      var c = cand();
      if (!c || typeof html !== 'string' || (STATE.cap && STATE.cap.tab === 'insights')) return html;
      var cards = cardsHtml(c);
      var at = html.indexOf('<h4>Resume</h4>');
      if (at > 0) {
        var start = html.lastIndexOf('<div class="cap-card', at);
        if (start > 0) return html.slice(0, start) + cards + html.slice(start);
      }
      var grid = html.lastIndexOf('</div>');
      return grid > 0 ? html.slice(0, grid) + cards + html.slice(grid) : html + cards;
    };
    next.__tlps = true;
    window.capProfile = next;
  }

  /* After each paint: the "Profile completion N%" line opens the breakdown. */
  function decorate() {
    if (location.hash.indexOf('#/candidate/profile') !== 0) return;
    Array.prototype.forEach.call(document.querySelectorAll('.cap-phead div'), function (el) {
      if (el.children.length || !/^Profile completion \d+%$/.test(el.textContent.trim()) || el.__tlps) return;
      el.__tlps = true;
      el.innerHTML = '<a role="button" tabindex="0" onclick="tlpsBreakdown()" '
        + 'onkeydown="if(event.key===\'Enter\')tlpsBreakdown()" '
        + 'style="color:inherit;text-decoration:underline dotted;cursor:pointer" title="See what is complete and what is missing">'
        + h(el.textContent.trim()) + '</a>';
    });
  }

  /* ------------------------------------------------------------------ *
   * 4. resume upload: status, count, review
   * ------------------------------------------------------------------ */

  var LABEL = {
    title: 'Job title', currentCompany: 'Current company', previousCompanies: 'Previous companies',
    location: 'Location', preferredLocation: 'Preferred location', noticePeriod: 'Notice period',
    education: 'Education', summary: 'Profile summary', skills: 'Key skills', certifications: 'Certifications',
    languages: 'Languages', linkedin: 'LinkedIn', github: 'GitHub', portfolio: 'Portfolio', expYears: 'Experience',
    phone: 'Phone', expectedSalary: 'Expected salary', currentSalary: 'Current salary', projects: 'Projects',
    internships: 'Internships / training', achievements: 'Achievements', employment: 'Employment',
  };
  var PUTKEY = { title: 'title', currentCompany: 'currentCompany', previousCompanies: 'previousCompanies',
    location: 'location', preferredLocation: 'preferredLocation', noticePeriod: 'noticePeriod',
    education: 'education', summary: 'summary', skills: 'skills', certifications: 'certifications',
    languages: 'languages', linkedin: 'linkedin', github: 'github', portfolio: 'portfolio', phone: 'phone' };

  var pending = null;
  window.tlpsUseSuggestion = function (k) {
    if (!pending || pending[k] === undefined || !PUTKEY[k]) return;
    var body = {}; body[PUTKEY[k]] = pending[k];
    save(body, LABEL[k] + ' updated from your resume').then(function () {
      delete pending[k];
      var rowEl = document.getElementById('tlpsSug_' + k); if (rowEl) rowEl.remove();
      if (!Object.keys(pending).length && typeof window.fcrCloseModal === 'function') fcrCloseModal();
    }).catch(function (e) { say((e && e.message) || 'That could not be saved.', '⚠️'); });
  };

  function review(sug) {
    var c = cand(); if (!c || typeof window.fcrModal !== 'function') return;
    var keys = Object.keys(sug || {}).filter(function (k) { return PUTKEY[k]; });
    if (!keys.length) return;
    pending = {}; keys.forEach(function (k) { pending[k] = sug[k]; });
    var show = function (v) { return h(Array.isArray(v) ? v.join(', ') : v).slice(0, 400) || '—'; };
    fcrModal('<div class="fcr-jd-head"><h3>Your resume says something different</h3>'
      + '<p>Your own entries were kept. Use the resume’s version where it is better.</p>'
      + '<button class="fcr-jd-x" onclick="fcrCloseModal()">✕</button></div><div class="fcr-jd-body">'
      + keys.map(function (k) {
        return '<div id="tlpsSug_' + k + '" style="border:1px solid #eef1f5;border-radius:10px;padding:10px 12px;margin-bottom:10px">'
          + '<b style="font-size:13px">' + h(LABEL[k] || k) + '</b>'
          + '<div style="font-size:12px;color:#6b7a90;margin-top:4px">On your profile: <span style="color:#26313f">' + show(c[PUTKEY[k]]) + '</span></div>'
          + '<div style="font-size:12px;color:#6b7a90;margin-top:2px">In your resume: <span style="color:#26313f">' + show(sug[k]) + '</span></div>'
          + '<button class="btn btn-ghost btn-sm" style="margin-top:7px" onclick="tlpsUseSuggestion(\'' + k + '\')">Use the resume’s version</button></div>';
      }).join('') + '</div><div class="fcr-jd-actions"><button class="btn btn-primary" onclick="fcrCloseModal()">Keep mine</button></div>');
  }

  function wrapUpload() {
    if (!window.TL || typeof TL.uploadResume !== 'function' || TL.uploadResume.__tlps) return;
    var prev = TL.uploadResume;
    var next = function () {
      var mine = STATE.session && STATE.session.role === 'candidate';
      if (mine) say('Resume uploaded — extracting profile information…', '⏳');
      return prev.apply(this, arguments).then(function (res) {
        if (!mine) return res;
        var p = res && res.parse;
        if (p && p.ok) {
          var n = (p.populated || []).length;
          say(n ? 'Resume processed. ' + n + ' profile field' + (n === 1 ? ' was' : 's were') + ' filled from it: '
            + (p.populated || []).map(function (k) { return LABEL[k] || k; }).join(', ') + '. Check them on your profile.'
            : 'Resume processed. Your profile already had everything it found.', '✅');
          var go = (p.populated || []).indexOf('employment') >= 0 && typeof TL.refresh === 'function'
            ? TL.refresh() : Promise.resolve();
          go.then(function () { rerender(); review(p.suggestions); });
        } else if (p && !p.ok) {
          say('Resume saved, but it could not be read: ' + (p.error || 'unknown reason') + ' You can fill your profile in by hand.', '⚠️');
        }
        return res;
      });
    };
    next.__tlps = true;
    TL.uploadResume = next;
  }

  /* ------------------------------------------------------------------ */

  function install() {
    wrapProfile();
    wrapInlineSave();
    wrapUpload();
    var prev = window.render;
    if (typeof prev === 'function' && !prev.__tlpsR) {
      var r = function () { var out = prev.apply(this, arguments); try { decorate(); } catch (e) {} return out; };
      r.__tlpsR = true;
      window.render = r;
    }
    rerender();
  }
  if (document.readyState === 'complete') install();
  else window.addEventListener('load', install);
})();
