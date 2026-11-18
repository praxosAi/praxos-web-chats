// Praxos for web chats: the part that runs on claude.ai and chatgpt.com.
// It reads the open conversation with the page's own login (the same requests
// the site's own app makes), converts it and hands it to the service worker,
// which ships it. Nothing here talks to Praxos, and no site credential leaves
// the page: ChatGPT's session token is used for the request it belongs to and
// is never stored or passed on.
(function () {
  'use strict';
  var C = globalThis.PraxosConvert;
  var QUIET_MS = 5000;        // the page has stopped changing for this long: the reply is likely complete
  var MAX_WAIT_MS = 45000;    // a page that never goes quiet is read anyway after this long
  var BACKFILL_GAP_MS = 1200; // between conversations when importing history
  var PAGE = 30;

  function getJson(url, headers) {
    return fetch(url, { credentials: 'include', headers: headers || {} }).then(function (r) {
      if (!r.ok) { var e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
      return r.json();
    });
  }

  var claude = {
    site: 'claude.ai',
    org: null,
    conversationId: function () {
      var m = location.pathname.match(/^\/chat\/([0-9a-f-]{36})/i);
      return m ? m[1] : null;
    },
    getOrg: function () {
      if (claude.org) return Promise.resolve(claude.org);
      var m = document.cookie.match(/(?:^|;\s*)lastActiveOrg=([^;]+)/);
      if (m) { claude.org = decodeURIComponent(m[1]); return Promise.resolve(claude.org); }
      return getJson('/api/organizations').then(function (orgs) {
        var pick = (orgs || []).filter(function (o) { return (o.capabilities || []).indexOf('chat') >= 0; })[0] || (orgs || [])[0];
        if (!pick) throw new Error('no organization');
        claude.org = pick.uuid;
        return claude.org;
      });
    },
    fetchSession: function (id) {
      return claude.getOrg().then(function (org) {
        return getJson('/api/organizations/' + org + '/chat_conversations/' + id + '?tree=True&rendering_mode=messages&render_all_tools=true');
      }).then(C.claudeToSession);
    },
    // One page of the account's conversations, newest first: [{id, updated, temporary}].
    list: function (offset) {
      return claude.getOrg().then(function (org) {
        return getJson('/api/organizations/' + org + '/chat_conversations?limit=' + PAGE + '&offset=' + offset);
      }).then(function (rows) {
        return (rows || []).map(function (r) {
          return { id: r.uuid, session_id: 'claudeai-' + r.uuid, updated: C.iso(r.updated_at), temporary: !!r.is_temporary };
        });
      });
    }
  };

  var chatgpt = {
    site: 'chatgpt.com',
    token: null, tokenAt: 0,
    conversationId: function () {
      var m = location.pathname.match(/\/c\/([0-9a-f-]{36})/i);
      return m ? m[1] : null;
    },
    auth: function () {
      if (chatgpt.token && Date.now() - chatgpt.tokenAt < 5 * 60000) return Promise.resolve(chatgpt.token);
      return getJson('/api/auth/session').then(function (s) {
        if (!s || !s.accessToken) throw new Error('not signed in to ChatGPT');
        chatgpt.token = s.accessToken; chatgpt.tokenAt = Date.now();
        return chatgpt.token;
      });
    },
    fetchSession: function (id) {
      return chatgpt.auth().then(function (t) {
        return getJson('/backend-api/conversation/' + id, { Authorization: 'Bearer ' + t });
      }).then(C.chatgptToSession);
    },
    list: function (offset) {
      return chatgpt.auth().then(function (t) {
        return getJson('/backend-api/conversations?offset=' + offset + '&limit=' + PAGE + '&order=updated', { Authorization: 'Bearer ' + t });
      }).then(function (d) {
        return ((d && d.items) || []).map(function (r) {
          return { id: r.id, session_id: 'chatgpt-' + r.id, updated: C.iso(r.update_time), temporary: false };
        });
      });
    }
  };

  var SITE = /(^|\.)claude\.ai$/.test(location.hostname) ? claude : chatgpt;

  function ask(msg) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(msg, function (reply) {
          if (chrome.runtime.lastError) return resolve(null);   // the extension was reloaded or removed
          resolve(reply || null);
        });
      } catch (e) { resolve(null); }
    });
  }

  // ---- the open conversation ----------------------------------------------
  var dirty = true, firstDirtyAt = 0, quietTimer = null, syncing = false, lastUrl = location.href;

  function touch() {
    if (!dirty) { dirty = true; firstDirtyAt = Date.now(); }
    clearTimeout(quietTimer);
    var wait = firstDirtyAt && Date.now() - firstDirtyAt > MAX_WAIT_MS ? 0 : QUIET_MS;
    quietTimer = setTimeout(sync, wait);
  }

  function sync() {
    var id = SITE.conversationId();
    if (!id || syncing || !dirty) return;
    syncing = true; dirty = false; firstDirtyAt = 0;
    ask({ type: 'may-ship', site: SITE.site, session_id: SITE === claude ? 'claudeai-' + id : 'chatgpt-' + id })
      .then(function (ok) {
        if (!ok || !ok.yes) return null;
        return SITE.fetchSession(id).then(function (session) {
          if (session.temporary || !session.messages.length) return null;
          return ask({ type: 'ship', session: session, imported: false });
        });
      })
      .catch(function () { /* a temporary chat, a deleted chat, a signed-out page: nothing to save */ })
      .then(function () { syncing = false; });
  }

  new MutationObserver(touch).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  setInterval(function () {             // these are single-page apps: the address changes without a load
    if (location.href !== lastUrl) { lastUrl = location.href; dirty = true; firstDirtyAt = Date.now(); touch(); }
  }, 1000);
  document.addEventListener('visibilitychange', function () { if (document.hidden && dirty) { clearTimeout(quietTimer); sync(); } });
  touch();

  // ---- history import -----------------------------------------------------
  var importing = false, stopImport = false;

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function importHistory() {
    if (importing) return;
    importing = true; stopImport = false;
    var seen = 0, saved = 0, failed = 0, offset = 0, error = null;
    var report = function (running) {
      return ask({ type: 'import-progress', site: SITE.site, running: running, seen: seen, saved: saved, failed: failed, error: error });
    };
    try {
      await report(true);
      while (!stopImport) {
        var rows = await SITE.list(offset);
        if (!rows.length) break;
        offset += rows.length;
        for (var i = 0; i < rows.length && !stopImport; i++) {
          var row = rows[i];
          seen += 1;
          if (row.temporary) continue;
          var need = await ask({ type: 'need', site: SITE.site, session_id: row.session_id, updated: row.updated });
          if (!need) { stopImport = true; break; }            // the extension went away
          if (!need.yes) { if (need.stop) stopImport = true; continue; }
          try {
            var session = await SITE.fetchSession(row.id);
            if (!session.temporary && session.messages.length) {
              var r = await ask({ type: 'ship', session: session, imported: true });
              if (r && r.ok) saved += 1; else failed += 1;
            }
          } catch (e) { failed += 1; }
          await report(true);
          await sleep(BACKFILL_GAP_MS);
        }
        if (rows.length < PAGE) break;
      }
    } catch (e) { error = String((e && e.message) || e); }
    importing = false;
    await report(false);
  }

  chrome.runtime.onMessage.addListener(function (msg, _sender, reply) {
    if (!msg) return;
    if (msg.type === 'current') {
      var id = SITE.conversationId();
      reply({ site: SITE.site, session_id: id ? (SITE === claude ? 'claudeai-' + id : 'chatgpt-' + id) : null, importing: importing });
    } else if (msg.type === 'import-start') { importHistory(); reply({ ok: true }); }
    else if (msg.type === 'import-stop') { stopImport = true; reply({ ok: true }); }
    else if (msg.type === 'sync-now') { dirty = true; sync(); reply({ ok: true }); }
  });
})();
