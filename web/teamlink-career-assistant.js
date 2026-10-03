/*
 * TeamLink — the AI Career Assistant, answered by the server.
 *
 * The page (#/candidate/assistant) and the floating "TeamLink AI" chat
 * used to answer from keyword rules in the browser, and the transcript
 * lived in page state - gone on refresh. Both now talk to
 * /api/career-assistant, which answers with Claude when the server has an
 * AI key and with the same rules, server-side, when it does not (shown
 * here as "Basic mode"). The conversation is stored by the server, so it
 * is still there after a refresh or on another device.
 *
 * What this file replaces, and nothing else:
 *   pageCareerAssistant, sendAssistantMessage, assistantSubmit  (the page)
 *   cpFabHtml, cpAsk                                             (the floating chat)
 *
 * Replies may contain **bold**, bullet lines and links to #/candidate/...
 * and #/job/<id>. They are ESCAPED FIRST and only those three things are
 * then turned back into markup - nothing else a reply contains can become
 * HTML. On a failure the candidate is told the assistant is unavailable;
 * no answer is ever invented in its place.
 *
 * window.TLCareerAssistant.openWith({ interviewId }) opens the assistant
 * on one interview (the interview prep kit's "Practice with AI Assistant").
 */
(function () {
  'use strict';

  var CHIPS = ['Improve my profile', 'What jobs match me?', 'Should I apply?', 'My career path', 'Interview prep', 'Salary fit'];
  var UNAVAILABLE = 'Assistant is unavailable right now, please try again.';

  var S = {
    owner: null,          // candidate id the state belongs to
    loaded: false, loading: null,
    convId: null,
    messages: [],         // { role:'user'|'assistant'|'error', text, engine }
    engine: null,         // 'ai' | 'rules' as the server last said
    sending: false,
  };

  var api = function () { return window.TL && TL.api; };
  var isCand = function () { return !!(window.STATE && STATE.session && STATE.session.role === 'candidate'); };
  var me = function () { return isCand() && window.DATA && DATA.candidateById ? DATA.candidateById(STATE.session.id) : null; };
  var h = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  };

  /* ------------------------------------------------------------------ *
   * safe markdown: escape everything, then allow three things back
   * ------------------------------------------------------------------ */

  var LINK = /\[([^\]\n]{1,120})\]\((#\/(?:candidate\/[a-z0-9\-\/]{1,40}|job\/[A-Za-z0-9_\-]{1,60}))\)/g;

  function inline(escaped) {
    return escaped
      .replace(LINK, function (_m, label, href) {
        return '<a class="tlca-a" href="' + href + '">' + label + '</a>';
      })
      .replace(/\*\*([^*\n]{1,200})\*\*/g, '<b>$1</b>');
  }

  function md(text) {
    var lines = h(text).split(/\r?\n/);
    var out = []; var list = null;
    lines.forEach(function (line) {
      var m = /^\s*(?:[-*•]|\d+\.)\s+(.*)$/.exec(line);
      if (m) {
        if (!list) { list = []; }
        list.push('<li>' + inline(m[1]) + '</li>');
        return;
      }
      if (list) { out.push('<ul class="tlca-ul">' + list.join('') + '</ul>'); list = null; }
      if (line.trim()) out.push('<div>' + inline(line) + '</div>');
      else out.push('<div class="tlca-gap"></div>');
    });
    if (list) out.push('<ul class="tlca-ul">' + list.join('') + '</ul>');
    return out.join('');
  }

  /* ------------------------------------------------------------------ *
   * the conversation, from the server
   * ------------------------------------------------------------------ */

  function reset() {
    S.owner = isCand() ? STATE.session.id : null;
    S.loaded = false; S.loading = null; S.convId = null; S.messages = []; S.engine = null; S.sending = false;
  }

  function load() {
    if (!isCand() || !api()) return Promise.resolve();
    if (S.owner !== STATE.session.id) reset();
    if (S.loaded) return Promise.resolve();
    if (S.loading) return S.loading;
    S.loading = api().get('/career-assistant/conversations')
      .then(function (out) {
        S.engine = out.engine || S.engine;
        var latest = (out.conversations || [])[0];
        if (!latest) return null;
        return api().get('/career-assistant/conversations/' + encodeURIComponent(latest.id)).then(function (c) {
          S.convId = c.conversationId;
          S.engine = c.engine || S.engine;
          S.messages = (c.messages || []).map(function (m) { return { role: m.role, text: m.text, engine: m.engine }; });
        });
      })
      .then(function () { S.loaded = true; S.loading = null; refresh(); })
      .catch(function () { S.loading = null; S.loaded = true; refresh(); });
    return S.loading;
  }

  function send(text, context) {
    text = String(text || '').trim();
    if (!text || S.sending || !isCand() || !api()) return Promise.resolve(null);
    S.messages.push({ role: 'user', text: text });
    S.sending = true;
    refresh(true);
    var body = { text: text };
    if (S.convId) body.conversationId = S.convId;
    if (context && context.interviewId) body.context = { interviewId: String(context.interviewId) };
    return api().post('/career-assistant/messages', body, { timeout: 90000 })
      .then(function (out) {
        S.convId = out.conversationId;
        S.engine = out.engine;
        S.messages.push({ role: 'assistant', text: out.reply, engine: out.engine });
        return out;
      })
      .catch(function (err) {
        var conv = err && err.code === 'NOT_FOUND';
        if (conv) S.convId = null;            // cleared elsewhere: the next message starts a new one
        var said = err && (err.code === 'ASSISTANT_RATE_LIMITED' || err.code === 'VALIDATION_FAILED') ? err.message : UNAVAILABLE;
        S.messages.push({ role: 'error', text: said });
        return null;
      })
      .then(function (out) { S.sending = false; refresh(true); return out; });
  }

  function clear() {
    if (!S.convId) { S.messages = []; refresh(); return Promise.resolve(); }
    if (typeof window.confirm === 'function' && !window.confirm('Clear this chat? The conversation will be deleted.')) return Promise.resolve();
    var id = S.convId;
    return api().del('/career-assistant/conversations/' + encodeURIComponent(id))
      .then(function () { S.convId = null; S.messages = []; refresh(); if (typeof toast === 'function') toast('Chat cleared', '🧹'); })
      .catch(function (err) { if (typeof toast === 'function') toast((err && err.message) || 'Could not clear the chat', '⚠️'); });
  }

  /* ------------------------------------------------------------------ *
   * drawing
   * ------------------------------------------------------------------ */

  function greeting() {
    var c = me();
    var first = c && c.name ? String(c.name).split(' ')[0] : '';
    return 'Hi' + (first ? ' ' + first : '') + '! I\'m your TeamLink Career Assistant. Ask me about improving your profile, '
      + 'jobs that match you, whether to apply, interview prep, salary or skill gaps.';
  }

  function bubbles(kind) {
    var list = S.messages.slice();
    var html = '';
    if (!list.length && S.loaded) html += row('assistant', greeting(), kind);
    if (!S.loaded) html += '<div class="tlca-note">Loading your conversation…</div>';
    list.forEach(function (m) { html += row(m.role, m.text, kind); });
    if (S.sending) html += row('typing', '', kind);
    return html;
  }

  function row(role, text, kind) {
    if (kind === 'fab') {
      if (role === 'typing') return '<div class="cp-msg"><div class="who">TeamLink AI</div><div class="bub tlca-typing"><i></i><i></i><i></i></div></div>';
      if (role === 'error') return '<div class="cp-msg tlca-err" role="alert"><div class="bub">⚠️ ' + h(text) + '</div></div>';
      var mine = role === 'user';
      return '<div class="cp-msg ' + (mine ? 'me' : '') + '"><div class="who">' + (mine ? 'You' : 'TeamLink AI') + '</div>'
        + '<div class="bub">' + (mine ? h(text) : md(text)) + '</div></div>';
    }
    if (role === 'typing') return '<div class="chat-msg assistant"><div class="bubble tlca-typing" aria-label="Assistant is typing"><i></i><i></i><i></i></div></div>';
    if (role === 'error') return '<div class="chat-msg assistant tlca-err" role="alert"><div class="bubble">⚠️ ' + h(text) + '</div></div>';
    return '<div class="chat-msg ' + (role === 'user' ? 'user' : 'assistant') + '"><div class="bubble">'
      + (role === 'user' ? h(text) : md(text)) + '</div></div>';
  }

  function modeBadge() {
    if (S.engine !== 'rules') return '';
    return '<span class="tlca-basic" title="The AI service is not switched on for this portal, so answers come from TeamLink\'s built-in rules.">Basic mode</span>';
  }

  function pageHtml() {
    return '<div class="panel ai-panel chat-panel tlca-panel">'
      + '<div class="panel-head"><h2>💬 AI Career Assistant ' + modeBadge() + '</h2>'
      + '<button class="btn btn-ghost btn-sm" type="button" onclick="TLCareerAssistant.clear()" ' + (S.messages.length ? '' : 'disabled') + '>Clear chat</button></div>'
      + '<div id="assistantChatBox" class="chat-box" aria-live="polite">' + bubbles('page') + '</div>'
      + '<div class="chat-chip-row">' + CHIPS.map(function (c) {
        return '<button class="chip-btn" type="button" ' + (S.sending ? 'disabled' : '') + ' onclick="sendAssistantMessage(\'' + c.replace(/'/g, '') + '\')">' + h(c) + '</button>';
      }).join('') + '</div>'
      + '<form onsubmit="return assistantSubmit(this)" class="chat-input-row">'
      + '<input id="assistantInput" maxlength="2000" placeholder="Ask about jobs, your profile, interview prep…" autocomplete="off">'
      + '<button class="btn btn-primary" type="submit" ' + (S.sending ? 'disabled' : '') + '>Send</button>'
      + '</form>'
      + '<div class="tlca-foot">Answers use your TeamLink profile, applications and open jobs. The assistant cannot apply or change anything for you. Don\'t share Aadhaar, PAN, bank details or passwords here.</div>'
      + '</div>';
  }

  var PROMPTS = ['Which jobs should I apply for?', 'Improve my resume', 'Why is my match score low?', 'What skills should I learn?', 'Prepare me for an interview', 'Is this salary good?'];

  function fabHtml() {
    var open = !!(window.STATE && STATE.cp && STATE.cp.chat);
    return '<button class="cp-fab" onclick="cpChat()">🤖 TeamLink AI</button>'
      + '<div class="cp-chat ' + (open ? 'on' : '') + '" onclick="event.stopPropagation()">'
      + '<div class="h"><span>🤖 TeamLink AI Career Assistant ' + modeBadge() + '</span>'
      + '<span style="display:flex;gap:4px;align-items:center">'
      + (S.messages.length ? '<button class="tlca-clear" type="button" onclick="TLCareerAssistant.clear()" title="Clear chat">Clear</button>' : '')
      + '<button class="cp-ico" onclick="cpChat(false)" aria-label="Close">✕</button></span></div>'
      + '<div class="b" id="cpChatBody" aria-live="polite">' + bubbles('fab')
      + (S.messages.length ? '' : '<div class="cp-sugg">' + PROMPTS.map(function (p) {
        return '<button onclick="cpAsk(\'' + p.replace(/'/g, "\\'") + '\')">' + h(p) + '</button>';
      }).join('') + '</div>')
      + '</div>'
      + '<div class="f"><input id="cpChatIn" maxlength="2000" placeholder="Ask anything about your job search…" onkeydown="if(event.key===\'Enter\')cpAsk(this.value)">'
      + '<button onclick="cpAsk(document.getElementById(\'cpChatIn\').value)" ' + (S.sending ? 'disabled' : '') + '>Send</button></div>'
      + '</div>';
  }

  /*
   * Update in place where the chat is on screen, so the box keeps its
   * scroll and the input keeps what is being typed; a full render only
   * when neither is there.
   */
  function refresh(scroll) {
    var page = document.getElementById('assistantChatBox');
    var fab = document.getElementById('cpChatBody');
    if (!page && !fab) { if (typeof window.render === 'function' && isCand()) render(); return; }
    if (page) {
      var panel = page.closest('.tlca-panel');
      var keep = document.getElementById('assistantInput');
      var typed = keep ? keep.value : '';
      var focused = keep && document.activeElement === keep;
      if (panel) {
        panel.outerHTML = pageHtml();
        var input = document.getElementById('assistantInput');
        if (input) { input.value = typed; if (focused) input.focus(); }
      }
    }
    if (fab) {
      var wrap = fab.closest('.cp-chat');
      var fabIn = document.getElementById('cpChatIn');
      var fabTyped = fabIn ? fabIn.value : '';
      if (wrap && wrap.previousElementSibling && wrap.previousElementSibling.classList.contains('cp-fab')) {
        var holder = document.createElement('div');
        holder.innerHTML = fabHtml();
        wrap.previousElementSibling.remove();
        wrap.replaceWith.apply(wrap, Array.prototype.slice.call(holder.childNodes));
        var ni = document.getElementById('cpChatIn'); if (ni) ni.value = fabTyped;
      }
    }
    if (scroll !== false) {
      setTimeout(function () {
        ['assistantChatBox', 'cpChatBody'].forEach(function (id) { var b = document.getElementById(id); if (b) b.scrollTop = b.scrollHeight; });
      }, 20);
    }
  }

  /* ------------------------------------------------------------------ *
   * the overrides
   * ------------------------------------------------------------------ */

  function install() {
    if (window.__tlcaInstalled) return;
    window.__tlcaInstalled = true;

    window.pageCareerAssistant = function () {
      if (!isCand()) return '';
      if (S.owner !== STATE.session.id) reset();
      if (!S.loaded) load();
      setTimeout(function () { var b = document.getElementById('assistantChatBox'); if (b) b.scrollTop = b.scrollHeight; }, 30);
      return pageHtml();
    };

    window.sendAssistantMessage = function (preset) {
      var input = document.getElementById('assistantInput');
      var text = preset || (input ? input.value.trim() : '');
      if (!text) return;
      if (input && !preset) input.value = '';
      send(text);
    };
    window.assistantSubmit = function () { window.sendAssistantMessage(); return false; };

    if (typeof window.cpFabHtml === 'function') {
      window.cpFabHtml = function () {
        if (!isCand()) return '';
        if (S.owner !== STATE.session.id) reset();
        if (!S.loaded && STATE.cp && STATE.cp.chat) load();
        return fabHtml();
      };
    }
    window.cpAsk = function (q) {
      q = String(q || '').trim();
      if (!q || !isCand()) return;
      var wasOpen = STATE.cp && STATE.cp.chat;
      STATE.cp = STATE.cp || {};
      STATE.cp.chat = true;
      var go = function () { send(q); var i = document.getElementById('cpChatIn'); if (i) i.value = ''; };
      if (!wasOpen && typeof window.render === 'function') render();
      if (!S.loaded) load().then(go); else go();
    };
    var prevChat = window.cpChat;
    if (typeof prevChat === 'function') {
      window.cpChat = function (on) {
        var out = prevChat.apply(this, arguments);
        if (STATE.cp && STATE.cp.chat && !S.loaded) load();
        return out;
      };
    }

    var prevRender = window.render;
    if (typeof prevRender === 'function' && !prevRender.__tlca) {
      var next = function () {
        var out = prevRender.apply(this, arguments);
        try { if ((isCand() ? STATE.session.id : null) !== S.owner) { reset(); } } catch (e) { /* never break a page */ }
        return out;
      };
      next.__tlca = true;
      window.render = next;
    }
    addStyle();
    /* If the page was already drawn with the old assistant (the session
       arrived before this file loaded), draw it again with this one. A
       render before the session is known would go to the login screen,
       so only then. */
    if (window.TL && TL.ready === true && isCand()
        && (/^#\/candidate\/assistant/.test(location.hash) || (STATE.cp && STATE.cp.chat))) {
      if (typeof window.render === 'function') render();
    }
  }

  function addStyle() {
    if (document.getElementById('tlcaStyle')) return;
    var s = document.createElement('style');
    s.id = 'tlcaStyle';
    s.textContent = [
      '.tlca-panel .panel-head{display:flex;align-items:center;justify-content:space-between;gap:10px}',
      '.tlca-basic{display:inline-block;vertical-align:middle;margin-left:8px;font-size:10.5px;font-weight:800;letter-spacing:.02em;',
      '  color:#5a6a7d;background:#eef1f6;border:1px solid #dfe5ec;border-radius:999px;padding:2px 8px;cursor:help}',
      '.tlca-ul{margin:4px 0;padding-left:18px}.tlca-ul li{margin:2px 0}',
      '.tlca-gap{height:6px}',
      '.tlca-a{color:#1d6ff2;font-weight:700;text-decoration:underline}',
      '.chat-msg.user .tlca-a{color:#fff}',
      '.tlca-err .bubble,.tlca-err .bub{background:#fdecec !important;color:#9b1c1c !important;border:1px solid #f5c2c2}',
      '.tlca-typing{display:inline-flex;gap:4px;align-items:center;min-height:18px}',
      '.tlca-typing i{width:6px;height:6px;border-radius:50%;background:#7b8794;display:inline-block;animation:tlcaDot 1s infinite ease-in-out}',
      '.tlca-typing i:nth-child(2){animation-delay:.15s}.tlca-typing i:nth-child(3){animation-delay:.3s}',
      '@keyframes tlcaDot{0%,80%,100%{opacity:.25;transform:translateY(0)}40%{opacity:1;transform:translateY(-3px)}}',
      '.tlca-note{font-size:12px;color:#8a94a6;padding:4px 2px}',
      '.tlca-foot{font-size:11px;color:#8a94a6;padding:8px 16px 12px;line-height:1.5}',
      '.tlca-clear{border:1px solid #dde4ec;background:#fff;border-radius:7px;padding:3px 8px;font-size:11px;font-weight:700;color:#5b6e84;cursor:pointer}',
      '@media (max-width:640px){.tlca-panel.chat-panel{height:calc(100vh - 170px)}.chat-msg .bubble{max-width:90%}}',
    ].join('\n');
    document.head.appendChild(s);
  }

  /* ------------------------------------------------------------------ *
   * the hook other features use
   * ------------------------------------------------------------------ */

  window.TLCareerAssistant = {
    /**
     * Open the assistant on one interview. Sends a first message with the
     * interview as context; the server checks the interview is the
     * candidate's own before telling the model anything about it.
     */
    openWith: function (opts) {
      opts = opts || {};
      if (!isCand()) return Promise.resolve(null);
      var text = opts.text || 'Help me prepare for my upcoming interview.';
      if (!/^#\/candidate\/assistant/.test(location.hash)) location.hash = '#/candidate/assistant';
      return load().then(function () { return send(text, { interviewId: opts.interviewId }); });
    },
    send: function (text) { return load().then(function () { return send(text); }); },
    clear: clear,
    load: load,
    state: function () { return { conversationId: S.convId, engine: S.engine, messages: S.messages.slice(), sending: S.sending }; },
    _md: md,
  };

  if (document.readyState === 'complete') install();
  else window.addEventListener('load', install);
})();
