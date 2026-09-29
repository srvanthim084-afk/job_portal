/* =====================================================================
   TEAMLINK — Add Candidate (quick add)

   FOUR FIELDS: name, phone, gender, email. Nothing else.

   This form used to ask for everything a candidate record can hold -
   identity, professional history, education rows, work experience rows,
   salary, notice period, documents, and a mandatory resume. A recruiter
   standing at a walk-in with a queue behind them was never going to fill
   that in, so the form went unused and the candidate was written down on
   paper instead.

   What it collects now is what somebody actually has in front of them
   when they meet a person. Everything else - the resume, the history,
   the preferences - the CANDIDATE fills in themselves, which is faster
   for the recruiter and more accurate, because it comes from the person
   it is about.

   THE POINT OF THE FORM IS THE LOGIN. Saving creates a TeamLink account
   and sends the credentials, so the candidate can go and complete their
   own profile. A saved candidate who cannot sign in is exactly what this
   replaces.

   NO PASSWORD PASSES THROUGH HERE. The server generates it, hashes it
   and sends it; this file never sees one and never asks for one.
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

  /* Forwards the ACTION too - window.toast is (msg, icon, label, fn), and
     a two-argument wrapper silently dropped the button off every toast
     raised here, including "Resend credentials". */
  function toast(msg, icon, actionLabel, actionFn) {
    if (typeof window.toast === 'function') {
      window.toast(msg, icon || 'ℹ️', actionLabel, actionFn);
    }
  }

  var state = { saving: false };

  /* ------------------------------------------------------------------ *
   * the fields
   * ------------------------------------------------------------------ */

  /* Dialling codes, India first because that is where the roles are. The
     code is stored with the number, so a number is never ambiguous about
     which country it belongs to. */
  var CODES = [
    ['+91', 'India'], ['+971', 'UAE'], ['+966', 'Saudi Arabia'], ['+974', 'Qatar'],
    ['+965', 'Kuwait'], ['+968', 'Oman'], ['+973', 'Bahrain'], ['+65', 'Singapore'],
    ['+60', 'Malaysia'], ['+44', 'UK'], ['+1', 'USA / Canada'], ['+61', 'Australia'],
    ['+64', 'New Zealand'], ['+49', 'Germany'], ['+353', 'Ireland'],
  ];

  function field(id, label, inner, hint) {
    return '<div class="acx-f">'
      + '<label class="acx-l" for="' + id + '">' + esc(label) + ' <i class="acx-req">*</i></label>'
      + inner
      + (hint ? '<span class="acx-hint">' + esc(hint) + '</span>' : '')
      + '<span class="acx-err" id="' + id + '_err"></span>'
      + '</div>';
  }

  function body() {
    return '<div class="acx-grid">'
      + field('acx_name', 'Full Name',
          '<input class="acx-i" id="acx_name" type="text" autocomplete="off" '
          + 'placeholder="As it should appear on their profile">')

      + '<div class="acx-f">'
      +   '<label class="acx-l" for="acx_phone">Phone Number <i class="acx-req">*</i></label>'
      +   '<div class="acx-phone">'
      +     '<select class="acx-i acx-cc" id="acx_cc">'
      +       CODES.map(function (c, i) {
            return '<option value="' + c[0] + '"' + (i === 0 ? ' selected' : '') + '>'
              + c[0] + ' ' + esc(c[1]) + '</option>';
          }).join('')
      +     '</select>'
      +     '<input class="acx-i" id="acx_phone" type="tel" inputmode="numeric" '
      +       'autocomplete="off" placeholder="98450 11111">'
      +   '</div>'
      +   '<span class="acx-err" id="acx_phone_err"></span>'
      + '</div>'

      + field('acx_gender', 'Gender',
          '<select class="acx-i" id="acx_gender">'
          + '<option value="">Select…</option>'
          + '<option value="Male">Male</option>'
          + '<option value="Female">Female</option>'
          + '<option value="Other">Other</option>'
          + '</select>')

      + field('acx_email', 'Email',
          '<input class="acx-i" id="acx_email" type="email" autocomplete="off" '
          + 'placeholder="name@example.com">',
          'Their login. The account and a temporary password are created when you save.')
      + '</div>';
  }

  /* ------------------------------------------------------------------ *
   * reading and checking
   * ------------------------------------------------------------------ */
  function v(id) {
    var el = document.getElementById(id);
    return el ? String(el.value || '').trim() : '';
  }
  function setErr(id, msg) {
    var e = document.getElementById(id + '_err');
    if (e) e.textContent = msg || '';
    var i = document.getElementById(id);
    if (i) i.classList.toggle('acx-bad', !!msg);
  }
  function clearErrs() {
    ['acx_name', 'acx_phone', 'acx_gender', 'acx_email'].forEach(function (id) { setErr(id, ''); });
  }

  function readForm() {
    return {
      name: v('acx_name'),
      cc: v('acx_cc') || '+91',
      phoneDigits: v('acx_phone').replace(/\D/g, ''),
      gender: v('acx_gender'),
      email: v('acx_email'),
    };
  }

  function validate(f) {
    var bad = [];
    var fail = function (id, msg) { setErr(id, msg); bad.push(id); };

    if (!f.name) fail('acx_name', 'Enter their full name.');
    else if (f.name.length < 2) fail('acx_name', 'That name looks too short.');

    if (!f.phoneDigits) fail('acx_phone', 'Enter a phone number.');
    /* Seven to fifteen digits covers every national format in the list
       above; the country code is held separately. */
    else if (f.phoneDigits.length < 7 || f.phoneDigits.length > 15) {
      fail('acx_phone', 'That does not look like a phone number.');
    } else if (f.cc === '+91' && f.phoneDigits.replace(/^0+/, '').length !== 10) {
      fail('acx_phone', 'An Indian mobile number has 10 digits.');
    }

    if (!f.gender) fail('acx_gender', 'Choose one.');

    if (!f.email) fail('acx_email', 'Enter their email address.');
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(f.email)) {
      fail('acx_email', 'That does not look like an email address.');
    }
    return bad;
  }

  /* ------------------------------------------------------------------ *
   * saving
   * ------------------------------------------------------------------ */
  window.acxSave = function () {
    if (state.saving) return;
    var a = api();
    if (!a) { toast('The server is not reachable — the candidate was not saved.', '⚠️'); return; }

    clearErrs();
    var f = readForm();
    var bad = validate(f);
    if (bad.length) {
      var first = document.getElementById(bad[0]);
      if (first) {
        first.scrollIntoView({ block: 'center', behavior: 'smooth' });
        try { first.focus({ preventScroll: true }); } catch (e) { /* older browsers */ }
      }
      return;
    }

    /* The record holds one name; the API takes two. Everything after the
       first space is the surname, which is right for "Meera Rao" and for
       "Nagasatya Narayanamma kona" alike. */
    var parts = f.name.split(/\s+/);
    var payload = {
      firstName: parts[0],
      lastName: parts.slice(1).join(' '),
      phone: f.cc + ' ' + f.phoneDigits,
      gender: f.gender,
      email: f.email,
      sendCredentials: true,
    };

    var btn = document.getElementById('acxSaveBtn');
    state.saving = true;
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    var done = function () {
      state.saving = false;
      if (btn) { btn.disabled = false; btn.textContent = 'Save Candidate'; }
    };

    a.post('/candidates', payload)
      .then(function (res) {
        done();
        if (typeof window.fcrCloseModal === 'function') window.fcrCloseModal();

        var cand = res.candidate;
        try {
          if (window.DATA && Array.isArray(DATA.candidates)) DATA.candidates.push(cand);
        } catch (e) { /* the navigation below refetches anyway */ }

        /*
         * WHAT ACTUALLY HAPPENED.
         *
         * The server says which channel reached 'sent'. Announcing
         * "login details sent" because the save returned 200 is the lie
         * this is written to avoid: the recruiter walks away believing
         * the candidate can sign in, and nobody finds out otherwise
         * until the candidate says so.
         */
        var c = res.credentials || {};
        var mailed = c.delivery && c.delivery.email === 'sent';

        if (mailed) {
          toast('Candidate added. Login details sent to ' + cand.email + '.', '✅');
        } else if (c.queued) {
          toast('Candidate added. Login details are on their way to ' + cand.email + '.', '✅',
            'Resend credentials', function () { window.acxResend(cand.id); });
        } else {
          toast('Candidate saved, but the email could not be sent'
            + (c.reason ? ' — ' + c.reason : ''), '⚠️',
            'Resend credentials', function () { window.acxResend(cand.id); });
        }

        if (typeof window.navigate === 'function') {
          window.navigate('/recruiter/candidates/' + cand.id);
        }
      })
      .catch(function (err) {
        done();

        /* A duplicate is not a failure of the form, it is an answer. Put
           on the field it belongs to, so the recruiter can see which of
           the two matched. */
        if (err && err.code === 'DUPLICATE_CANDIDATE') {
          var d = (err.details && err.details.duplicates) || [];
          var byEmail = d.some(function (x) {
            return x.email && String(x.email).toLowerCase() === f.email.toLowerCase();
          });
          var msg = 'A candidate with this ' + (byEmail ? 'email' : 'phone') + ' already exists.';
          setErr(byEmail ? 'acx_email' : 'acx_phone', msg);
          toast(msg, '⚠️');
          return;
        }

        if (err && err.details) {
          var FIELD_OF = {
            firstName: 'acx_name', lastName: 'acx_name', phone: 'acx_phone',
            email: 'acx_email', gender: 'acx_gender',
          };
          var shown = 0;
          Object.keys(err.details).forEach(function (k) {
            if (FIELD_OF[k]) { setErr(FIELD_OF[k], err.details[k]); shown += 1; }
          });
          if (shown) return;
        }
        toast((err && err.message) || 'The candidate could not be saved', '⚠️');
      });
  };

  /* ------------------------------------------------------------------ *
   * sending the login again
   *
   * The endpoint has always existed - it issues a fresh temporary
   * password and invalidates the one before it - but nothing in the
   * interface ever called it, so a candidate whose invitation bounced
   * could only be helped by somebody willing to make the request by
   * hand.
   *
   * THE PASSWORD NEVER COMES BACK HERE. The response says which channels
   * were reached and nothing else.
   * ------------------------------------------------------------------ */
  window.acxResend = function (candidateId, btnEl) {
    var a = api();
    if (!a || !candidateId) return;
    if (btnEl) { btnEl.disabled = true; btnEl.textContent = 'Sending…'; }

    a.post('/candidates/' + encodeURIComponent(candidateId) + '/invite', {})
      .then(function (res) {
        var d = (res && res.delivery) || {};
        var ok = Object.keys(d).filter(function (k) { return d[k] === 'sent'; });
        if (ok.length) toast('Login details sent by ' + ok.join(' and ') + '.', '✅');
        else {
          toast('Nothing could be delivered'
            + (res && res.reason ? ' — ' + res.reason : '') + '.', '⚠️');
        }
      })
      .catch(function (err) {
        toast((err && err.message) || 'The credentials could not be sent', '⚠️');
      })
      .then(function () {
        if (btnEl) { btnEl.disabled = false; btnEl.textContent = 'Resend credentials'; }
      });
  };

  /* ------------------------------------------------------------------ *
   * open / close
   * ------------------------------------------------------------------ */
  window.acxCancel = function () {
    if (typeof window.fcrCloseModal === 'function') window.fcrCloseModal();
  };

  window.openAddCandidate = function () {
    if (typeof window.fcrModal !== 'function') {
      toast('The form could not be opened on this screen', '⚠️');
      return;
    }
    state = { saving: false };

    window.fcrModal(
      '<div class="fcr-jd-head acx-head">'
      + '<h3>Add Candidate</h3>'
      + '<div class="acx-sub">Four details now. A TeamLink login is created and sent to '
      + 'them, and they fill in the rest themselves.</div>'
      + '<button class="fcr-jd-x" onclick="acxCancel()">✕</button></div>'
      + '<div class="fcr-jd-body acx-body">' + body() + '</div>'
      + '<div class="acx-foot">'
      + '<button class="btn btn-ghost" onclick="acxCancel()">Cancel</button>'
      + '<button class="btn btn-primary" id="acxSaveBtn" onclick="acxSave()">Save Candidate</button>'
      + '</div>');

    setTimeout(function () {
      var n = document.getElementById('acx_name');
      if (n) { try { n.focus(); } catch (e) { /* older browsers */ } }
    }, 60);
  };

  /* ------------------------------------------------------------------ *
   * styles, scoped to this form
   * ------------------------------------------------------------------ */
  var css = ''
    + '.acx-head .acx-sub{font-size:12px;color:#5b6b82;margin-top:4px;max-width:46ch}'
    + '.acx-body{padding-bottom:4px}'
    + '.acx-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px 16px}'
    + '.acx-f{display:flex;flex-direction:column;gap:4px;min-width:0}'
    + '.acx-f:nth-child(1),.acx-f:nth-child(4){grid-column:1 / -1}'
    + '.acx-l{font-size:12px;font-weight:700;color:#41506a}'
    + '.acx-req{color:#d4342c;font-style:normal}'
    + '.acx-i{width:100%;padding:9px 10px;border:1px solid #d9e0ea;border-radius:8px;'
      + 'font:inherit;font-size:13px;background:#fff;color:#1b2536;box-sizing:border-box}'
    + '.acx-i:focus{outline:0;border-color:#5b5bd6;box-shadow:0 0 0 3px rgba(91,91,214,.12)}'
    + '.acx-i.acx-bad{border-color:#d4342c;background:#fff7f6}'
    + '.acx-phone{display:flex;gap:8px}'
    + '.acx-cc{flex:0 0 132px;width:132px}'
    + '.acx-err{color:#d4342c;font-size:11.5px;line-height:1.35}'
    + '.acx-err:empty{display:none}'
    + '.acx-hint{color:#7a8798;font-size:11.5px;line-height:1.4}'
    + '.acx-foot{border-top:1px solid #e9edf3;padding:14px 26px;display:flex;'
      + 'justify-content:flex-end;gap:10px;border-radius:0 0 12px 12px}'
    + '@media (max-width:620px){.acx-grid{grid-template-columns:1fr}'
      + '.acx-f:nth-child(n){grid-column:1 / -1}'
      + '.acx-cc{flex:0 0 116px;width:116px}}';

  var tag = document.createElement('style');
  tag.id = 'acx-add-candidate-css';
  tag.textContent = css;
  (document.head || document.documentElement).appendChild(tag);
}());
