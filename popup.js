// Praxos for web chats: the popup. It only shows and changes the service
// worker's state; nothing is saved from here.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var SITE_NAMES = { 'claude.ai': 'Claude.ai', 'chatgpt.com': 'ChatGPT' };
  var tab = null, current = null, pollTimer = null;

  function send(msg) {
    return new Promise(function (resolve) {
      chrome.runtime.sendMessage(msg, function (r) { resolve(chrome.runtime.lastError ? null : r); });
    });
  }
  function sendTab(msg) {
    return new Promise(function (resolve) {
      if (!tab) return resolve(null);
      chrome.tabs.sendMessage(tab.id, msg, function (r) { resolve(chrome.runtime.lastError ? null : r); });
    });
  }
  function show(id, on) { $(id).hidden = !on; }

  function ago(ms) {
    var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' d ago';
  }

  async function render() {
    var st = await send({ type: 'state' });
    if (!st) return;
    show('signed-out', !st.signed_in && !st.link);
    show('linking', !st.signed_in && !!st.link);
    show('signed-in', st.signed_in);
    $('error').textContent = st.last_error || '';
    show('error', !!st.last_error);

    if (!st.signed_in && st.link) {
      $('code').textContent = st.link.user_code;
      $('open-praxos').href = st.link.verification_url;
      if (!pollTimer) pollTimer = setInterval(async function () {
        var r = await send({ type: 'poll' });
        if (r && r.status !== 'pending') { clearInterval(pollTimer); pollTimer = null; render(); }
      }, 3000);
    }
    if (!st.signed_in) return;

    $('paused').checked = !st.paused;
    document.querySelectorAll('input[data-site]').forEach(function (el) {
      el.checked = !!st.enabled[el.dataset.site];
      el.disabled = st.paused;
    });

    current = await sendTab({ type: 'current' });
    var onSite = !!(current && current.site);
    show('this-chat', onSite && !!current.session_id);
    if (onSite && current.session_id) {
      $('skip').checked = !st.skipped[current.session_id];
      $('skip').disabled = st.paused || !st.enabled[current.site];
    }
    show('history', onSite);
    if (onSite) {
      var imp = st.imports[current.site];
      var running = !!current.importing;
      $('history-title').textContent = 'Earlier chats on ' + (SITE_NAMES[current.site] || current.site);
      $('import').textContent = running ? 'Stop' : 'Import';
      $('import').disabled = st.paused || !st.enabled[current.site];
      var line = '';
      if (running && imp) line = 'Importing: ' + imp.saved + ' saved of ' + imp.seen + ' checked. Keep this tab open.';
      else if (imp && imp.error) line = 'Stopped: ' + imp.error + ' (' + imp.saved + ' saved).';
      else if (imp) line = 'Last import ' + ago(imp.at) + ': ' + imp.saved + ' saved, ' + imp.seen + ' checked' + (imp.failed ? ', ' + imp.failed + ' failed' : '') + '.';
      else line = 'Saves every past chat on this site. It runs in this tab and can be stopped.';
      $('history-status').textContent = line;
      if (running) setTimeout(render, 2000);
    }
    $('stats').textContent = st.saved_messages
      ? st.saved_messages.toLocaleString() + ' messages saved' + (st.last_saved_at ? ', last ' + ago(st.last_saved_at) : '') + '.'
      : 'Nothing saved yet. Open a chat and it is saved a few seconds after each reply.';
  }

  $('connect').addEventListener('click', async function () {
    $('connect').disabled = true;
    var r = await send({ type: 'sign-in' });
    $('connect').disabled = false;
    if (r && r.verification_url) chrome.tabs.create({ url: r.verification_url, active: false });
    else if (r && r.error) { $('error').textContent = r.error; show('error', true); }
    render();
  });
  $('cancel-link').addEventListener('click', async function () { await send({ type: 'sign-out' }); render(); });
  $('disconnect').addEventListener('click', async function () { await send({ type: 'sign-out' }); render(); });
  $('paused').addEventListener('change', async function (e) { await send({ type: 'set-paused', on: !e.target.checked }); render(); });
  document.querySelectorAll('input[data-site]').forEach(function (el) {
    el.addEventListener('change', async function () { await send({ type: 'set-site', site: el.dataset.site, on: el.checked }); render(); });
  });
  $('skip').addEventListener('change', async function (e) {
    if (!current || !current.session_id) return;
    await send({ type: 'set-skipped', session_id: current.session_id, on: !e.target.checked });
    if (e.target.checked) sendTab({ type: 'sync-now' });
    render();
  });
  $('import').addEventListener('click', async function () {
    await sendTab({ type: current && current.importing ? 'import-stop' : 'import-start' });
    setTimeout(render, 400);
  });

  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) { tab = (tabs && tabs[0]) || null; render(); });
})();
