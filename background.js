// Praxos for web chats: the service worker. It holds the Praxos sign-in,
// decides what may be saved, and ships conversations to Praxos through the
// same ingest the coding-agent shipper uses (provider web_chat).
importScripts('lib/convert.js');
var C = self.PraxosConvert;

var VERSION = chrome.runtime.getManifest().version;
var API = 'https://api.mypraxos.com/api';                                  // sign-in (device link)
var INGEST = 'https://hooks.mypraxos.com/ingress/agent-cli/web-chat/messages';
var SITES = ['claude.ai', 'chatgpt.com'];
var BATCH_COUNT = 200, BATCH_BYTES = 400 * 1024;
var POLL_MS = 3000;

function get(keys) { return chrome.storage.local.get(keys); }
function set(obj) { return chrome.storage.local.set(obj); }

async function settings() {
  var s = await get(['token', 'enabled', 'paused', 'skipped']);
  var enabled = Object.assign({}, s.enabled || {});
  SITES.forEach(function (site) { if (enabled[site] === undefined) enabled[site] = true; });
  return { token: s.token || null, enabled: enabled, paused: !!s.paused, skipped: s.skipped || {} };
}

// May this conversation be saved right now? {yes} or {yes: false, why, stop}.
async function allowed(site, sessionId) {
  var s = await settings();
  if (!s.token) return { yes: false, why: 'signed-out', stop: true };
  if (s.paused) return { yes: false, why: 'paused', stop: true };
  if (!s.enabled[site]) return { yes: false, why: 'site-off', stop: true };
  if (sessionId && s.skipped[sessionId]) return { yes: false, why: 'skipped' };
  return { yes: true };
}

// ---- shipping ---------------------------------------------------------------
var chains = {};   // one ship at a time per conversation, so two reads of it cannot interleave

function ship(session, imported) {
  var key = session.session_id;
  var run = (chains[key] || Promise.resolve()).then(function () { return shipNow(session, imported); },
                                                    function () { return shipNow(session, imported); });
  chains[key] = run.catch(function () {});
  return run;
}

async function shipNow(session, imported) {
  var ok = await allowed(session.site, session.session_id);
  if (!ok.yes) return { ok: false, why: ok.why };
  var token = (await settings()).token;
  var stateKey = 's:' + session.session_id;
  var stored = (await get(stateKey))[stateKey] || null;
  var pick = C.selectToShip(session.messages, stored);
  var sent = 0;
  var groups = C.batches(pick.send, BATCH_COUNT, BATCH_BYTES);
  for (var i = 0; i < groups.length; i++) {
    var res = await fetch(INGEST, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({
        session_id: session.session_id,
        project_dir: session.site,          // names the session "Web: claude.ai"
        project_slug: session.site,
        machine_name: 'browser',
        shipper_version: 'web-ext-' + VERSION,
        imported: !!imported,
        session_summary: session.title || null,
        messages: groups[i]
      })
    });
    if (res.status === 401) {
      await set({ token: null, last_error: 'Praxos no longer accepts this sign-in. Connect again.' });
      return { ok: false, why: 'signed-out' };
    }
    if (!res.ok) {
      await set({ last_error: 'Praxos answered ' + res.status + ' while saving a chat.' });
      return { ok: false, why: 'http-' + res.status };
    }
    sent += groups[i].length;
  }
  var next = Object.assign({}, pick.state, { updated: session.updated || '', title: session.title || '' });
  var write = {}; write[stateKey] = next;
  if (sent) {
    var st = await get(['saved_messages']);
    write.saved_messages = (st.saved_messages || 0) + sent;
    write.last_saved_at = Date.now();
    write.last_error = null;
  }
  await set(write);
  return { ok: true, sent: sent };
}

// History import asks before fetching a conversation: is there anything newer than what was saved?
async function need(site, sessionId, updated) {
  var ok = await allowed(site, sessionId);
  if (!ok.yes) return ok;
  var stateKey = 's:' + sessionId;
  var stored = (await get(stateKey))[stateKey];
  if (stored && stored.updated && updated && stored.updated >= updated) return { yes: false, why: 'current' };
  return { yes: true };
}

// ---- sign-in (device link) ----------------------------------------------------
// The extension opens a pairing request, the person approves its short code in
// Praxos (already signed in there), and the poll hands back a token made for
// this browser. Removing the connection in Praxos turns the token off.
async function backend(path, body) {
  var res = await fetch(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  var json = await res.json().catch(function () { return null; });
  if (!res.ok || !json) throw new Error('Praxos answered ' + res.status);
  if (json && typeof json === 'object' && 'success' in json && 'data' in json) {
    if (!json.success) throw new Error((json.error && json.error.message) || 'Praxos refused the request');
    return json.data;
  }
  return json;
}

// Only an https address on mypraxos.com is ever opened or shown as the place to approve a sign-in.
function praxosUrl(url) {
  try {
    var u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'mypraxos.com' || u.hostname.endsWith('.mypraxos.com'));
  } catch (e) { return false; }
}

async function signIn() {
  var d = await backend('/auth/device-link/start', { tool: 'web-chat' });
  // The pairing page takes the code in its address, so it opens filled in and the person only approves.
  var url = String(d.verification_url || '');
  if (!praxosUrl(url)) throw new Error('Praxos sent a sign-in address that is not a Praxos address');
  if (url && d.user_code) url += (url.indexOf('?') >= 0 ? '&' : '?') + 'code=' + encodeURIComponent(d.user_code);
  var link = { poll_secret: d.poll_secret, user_code: d.user_code, verification_url: url,
               expires_at: Date.now() + (d.expires_in || 600) * 1000 };
  await set({ link: link, last_error: null });
  chrome.alarms.create('link-poll', { periodInMinutes: 0.5 });
  pollLoop();
  return { user_code: link.user_code, verification_url: link.verification_url };
}

async function pollOnce() {
  var link = (await get('link')).link;
  if (!link) return 'none';
  if (Date.now() > link.expires_at) { await set({ link: null }); chrome.alarms.clear('link-poll'); return 'expired'; }
  var d;
  try { d = await backend('/auth/device-link/poll', { poll_secret: link.poll_secret }); }
  catch (e) { return 'pending'; }
  if (d.status === 'approved' && d.token) {
    await set({ token: d.token, link: null, last_error: null });
    chrome.alarms.clear('link-poll');
    return 'approved';
  }
  if (d.status === 'expired') { await set({ link: null }); chrome.alarms.clear('link-poll'); return 'expired'; }
  return 'pending';
}

var polling = false;
async function pollLoop() {
  if (polling) return;
  polling = true;
  try {
    while ((await pollOnce()) === 'pending') await new Promise(function (r) { setTimeout(r, POLL_MS); });
  } finally { polling = false; }
}

chrome.alarms.onAlarm.addListener(function (a) { if (a.name === 'link-poll') pollLoop(); });

// ---- messages from the pages and the popup -------------------------------------
async function popupState() {
  var s = await settings();
  var extra = await get(['link', 'saved_messages', 'last_saved_at', 'last_error', 'imports']);
  return { signed_in: !!s.token, enabled: s.enabled, paused: s.paused, skipped: s.skipped,
           link: extra.link ? { user_code: extra.link.user_code, verification_url: extra.link.verification_url } : null,
           saved_messages: extra.saved_messages || 0, last_saved_at: extra.last_saved_at || null,
           last_error: extra.last_error || null, imports: extra.imports || {}, version: VERSION };
}

async function handle(msg) {
  switch (msg && msg.type) {
    case 'may-ship': return allowed(msg.site, msg.session_id);
    case 'ship': return ship(msg.session, msg.imported);
    case 'need': return need(msg.site, msg.session_id, msg.updated);
    case 'import-progress': {
      var imports = (await get('imports')).imports || {};
      imports[msg.site] = { running: !!msg.running, seen: msg.seen, saved: msg.saved, failed: msg.failed,
                            error: msg.error || null, at: Date.now() };
      await set({ imports: imports });
      return { ok: true };
    }
    case 'state': return popupState();
    case 'sign-in': return signIn();
    case 'poll': return { status: await pollOnce() };
    case 'sign-out': await set({ token: null, link: null }); chrome.alarms.clear('link-poll'); return { ok: true };
    case 'set-site': {
      var s = await settings(); s.enabled[msg.site] = !!msg.on; await set({ enabled: s.enabled }); return { ok: true };
    }
    case 'set-paused': await set({ paused: !!msg.on }); return { ok: true };
    case 'set-skipped': {
      var cur = (await settings()).skipped;
      if (msg.on) cur[msg.session_id] = true; else delete cur[msg.session_id];
      await set({ skipped: cur });
      return { ok: true };
    }
    default: return null;
  }
}

// Who may ask for what: a conversation can only come from a tab that is on the site it claims to be from, and
// settings and sign-in only from the popup (which is not a tab).
var FROM_PAGE = { 'may-ship': 1, 'ship': 1, 'need': 1, 'import-progress': 1 };
function senderAllowed(msg, sender) {
  var tabUrl = sender && sender.tab && sender.tab.url;
  if (!msg || !FROM_PAGE[msg.type]) return !tabUrl;
  var site = msg.type === 'ship' ? (msg.session && msg.session.site) : msg.site;
  if (!tabUrl || SITES.indexOf(site) < 0) return false;
  try {
    var host = new URL(tabUrl).hostname;
    return host === site || host.endsWith('.' + site);
  } catch (e) { return false; }
}

chrome.runtime.onMessage.addListener(function (msg, sender, reply) {
  if (!senderAllowed(msg, sender)) { reply({ ok: false, yes: false, why: 'not-allowed' }); return false; }
  handle(msg).then(reply, function (e) { reply({ ok: false, error: String((e && e.message) || e) }); });
  return true;   // the reply comes later
});
