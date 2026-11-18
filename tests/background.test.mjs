// The service worker under a fake browser: sign-in by device link, shipping
// through the ingest, the switches, and history-import decisions.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function boot(server) {
  const store = {};
  let listener = null;
  const alarms = {};
  const ctx = {
    console, setTimeout: (fn) => setTimeout(fn, 0), clearTimeout, Promise, Date, JSON, Object, URL,
    chrome: {
      runtime: { getManifest: () => ({ version: '9.9.9' }), onMessage: { addListener: (fn) => { listener = fn; } } },
      storage: { local: {
        get: async (keys) => { const out = {}; for (const k of [].concat(keys)) if (k in store) out[k] = structuredClone(store[k]); return out; },
        set: async (obj) => { for (const k of Object.keys(obj)) store[k] = structuredClone(obj[k]); },
      } },
      alarms: { create: (n, o) => { alarms[n] = o; }, clear: (n) => { delete alarms[n]; }, onAlarm: { addListener: () => {} } },
    },
    fetch: async (url, init) => server(url, init),
  };
  ctx.self = ctx;
  ctx.importScripts = (f) => vm.runInContext(fs.readFileSync(path.join(EXT, f), 'utf8'), vmctx, { filename: f });
  const vmctx = vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(EXT, 'background.js'), 'utf8'), vmctx, { filename: 'background.js' });
  // Replies are made inside the vm (another realm): a JSON round trip makes them plain objects here.
  // Page messages arrive from a tab on the site they name, everything else from the popup (no tab), as in the browser.
  const PAGE = ['may-ship', 'ship', 'need', 'import-progress'];
  const from = (msg) => PAGE.includes(msg.type)
    ? { tab: { url: 'https://' + ((msg.session && msg.session.site) || msg.site) + '/chat/x' } } : {};
  const send = (msg, sender) => new Promise((resolve) => listener(msg, sender || from(msg), (r) => resolve(r === undefined ? r : JSON.parse(JSON.stringify(r)))));
  return { send, store, alarms };
}

const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

function praxos() {
  const calls = [];
  let approved = false, ingestStatus = 200;
  const server = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, auth: (init.headers || {}).Authorization });
    if (url.endsWith('/auth/device-link/start')) return json(200, { success: true, data: { user_code: 'ABCD-1234', poll_secret: 'POLLSECRET', verification_url: 'https://app.mypraxos.com/?overlay=link-device', expires_in: 600 } });
    if (url.endsWith('/auth/device-link/poll')) return json(200, { success: true, data: approved ? { status: 'approved', token: 'pxwb_abc_secret' } : { status: 'pending' } });
    if (url.includes('/ingress/agent-cli/web-chat/messages')) return json(ingestStatus, { status: 'ok' });
    return json(404, {});
  };
  return { server, calls, approve: () => { approved = true; }, ingest: (s) => { ingestStatus = s; },
           ingests: () => calls.filter(c => c.url.includes('/ingress/')) };
}

const session = (n = 3, extra = {}) => ({
  site: 'claude.ai', session_id: 'claudeai-c1', title: 'Plan', updated: '2026-11-01T10:05:00.000Z', temporary: false,
  messages: Array.from({ length: n }, (_, i) => ({ uuid: 'web:claude.ai:m' + i, parent_uuid: i ? 'web:claude.ai:m' + (i - 1) : null,
    ts: new Date(Date.UTC(2026, 10, 1, 10, i)).toISOString(), role: i % 2 ? 'assistant' : 'user', text: 'text ' + i, tool_call_count: 0 })),
  ...extra,
});

async function signedIn() {
  const p = praxos();
  const b = boot(p.server);
  p.approve();
  await b.send({ type: 'sign-in' });
  for (let i = 0; i < 50 && !b.store.token; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(b.store.token, 'pxwb_abc_secret');
  return { p, b };
}

test('nothing is sent before sign-in', async () => {
  const p = praxos();
  const b = boot(p.server);
  assert.deepEqual(await b.send({ type: 'may-ship', site: 'claude.ai', session_id: 'x' }), { yes: false, why: 'signed-out', stop: true });
  const r = await b.send({ type: 'ship', session: session() });
  assert.equal(r.ok, false);
  assert.equal(p.calls.length, 0);
});

test('sign-in: a code to approve, then the token from the poll', async () => {
  const p = praxos();
  const b = boot(p.server);
  const start = await b.send({ type: 'sign-in' });
  assert.equal(start.user_code, 'ABCD-1234');
  assert.equal(start.verification_url, 'https://app.mypraxos.com/?overlay=link-device&code=ABCD-1234');
  assert.equal(p.calls[0].body.tool, 'web-chat');
  let st = await b.send({ type: 'state' });
  assert.equal(st.signed_in, false);
  assert.equal(st.link.user_code, 'ABCD-1234');
  assert.equal(JSON.stringify(st).includes('POLLSECRET'), false);        // the poll secret never reaches the popup
  p.approve();
  assert.equal((await b.send({ type: 'poll' })).status, 'approved');
  st = await b.send({ type: 'state' });
  assert.equal(st.signed_in, true);
  assert.equal(st.link, null);
  assert.equal(JSON.stringify(st).includes('pxwb_'), false);     // nor does the token
});

test('a conversation ships once, then only what is new', async () => {
  const { p, b } = await signedIn();
  assert.deepEqual(await b.send({ type: 'ship', session: session(3) }), { ok: true, sent: 3 });
  const first = p.ingests()[0];
  assert.equal(first.auth, 'Bearer pxwb_abc_secret');
  assert.equal(first.url, 'https://hooks.mypraxos.com/ingress/agent-cli/web-chat/messages');
  assert.deepEqual([first.body.session_id, first.body.project_dir, first.body.session_summary, first.body.imported, first.body.shipper_version],
                   ['claudeai-c1', 'claude.ai', 'Plan', false, 'web-ext-9.9.9']);
  assert.deepEqual(await b.send({ type: 'ship', session: session(3) }), { ok: true, sent: 0 });
  assert.equal(p.ingests().length, 1);
  assert.deepEqual(await b.send({ type: 'ship', session: session(5) }), { ok: true, sent: 2 });
  assert.deepEqual(p.ingests()[1].body.messages.map(m => m.uuid), ['web:claude.ai:m3', 'web:claude.ai:m4']);
  assert.equal((await b.send({ type: 'state' })).saved_messages, 5);
});

test('a long conversation goes in batches of 200', async () => {
  const { p, b } = await signedIn();
  assert.deepEqual(await b.send({ type: 'ship', session: session(450) }), { ok: true, sent: 450 });
  assert.deepEqual(p.ingests().map(c => c.body.messages.length), [200, 200, 50]);
});

test('a failed request keeps nothing as sent, so the next read retries it', async () => {
  const { p, b } = await signedIn();
  p.ingest(503);
  assert.equal((await b.send({ type: 'ship', session: session(3) })).ok, false);
  assert.match((await b.send({ type: 'state' })).last_error, /503/);
  p.ingest(200);
  assert.deepEqual(await b.send({ type: 'ship', session: session(3) }), { ok: true, sent: 3 });
  assert.equal((await b.send({ type: 'state' })).last_error, null);
});

test('a refused token signs the browser out', async () => {
  const { p, b } = await signedIn();
  p.ingest(401);
  assert.equal((await b.send({ type: 'ship', session: session(3) })).why, 'signed-out');
  assert.equal((await b.send({ type: 'state' })).signed_in, false);
});

test('pause, a site switch and a skipped chat each stop saving', async () => {
  const { p, b } = await signedIn();
  await b.send({ type: 'set-paused', on: true });
  assert.equal((await b.send({ type: 'ship', session: session() })).why, 'paused');
  await b.send({ type: 'set-paused', on: false });
  await b.send({ type: 'set-site', site: 'claude.ai', on: false });
  assert.equal((await b.send({ type: 'ship', session: session() })).why, 'site-off');
  assert.equal((await b.send({ type: 'may-ship', site: 'chatgpt.com', session_id: 'chatgpt-1' })).yes, true);
  await b.send({ type: 'set-site', site: 'claude.ai', on: true });
  await b.send({ type: 'set-skipped', session_id: 'claudeai-c1', on: true });
  assert.equal((await b.send({ type: 'ship', session: session() })).why, 'skipped');
  assert.equal(p.ingests().length, 0);
  await b.send({ type: 'set-skipped', session_id: 'claudeai-c1', on: false });
  assert.equal((await b.send({ type: 'ship', session: session() })).ok, true);
});

test('history import: only chats with something newer are fetched, and imports are marked', async () => {
  const { p, b } = await signedIn();
  assert.equal((await b.send({ type: 'need', site: 'claude.ai', session_id: 'claudeai-c1', updated: '2026-11-01T10:05:00.000Z' })).yes, true);
  await b.send({ type: 'ship', session: session(3), imported: true });
  assert.equal(p.ingests()[0].body.imported, true);
  assert.equal((await b.send({ type: 'need', site: 'claude.ai', session_id: 'claudeai-c1', updated: '2026-11-01T10:05:00.000Z' })).yes, false);
  assert.equal((await b.send({ type: 'need', site: 'claude.ai', session_id: 'claudeai-c1', updated: '2026-11-02T00:00:00.000Z' })).yes, true);
  await b.send({ type: 'set-paused', on: true });
  assert.deepEqual(await b.send({ type: 'need', site: 'claude.ai', session_id: 'claudeai-c2', updated: 'x' }), { yes: false, why: 'paused', stop: true });
});

test('disconnect forgets the token', async () => {
  const { b } = await signedIn();
  await b.send({ type: 'sign-out' });
  assert.equal(b.store.token, null);
  assert.equal((await b.send({ type: 'state' })).signed_in, false);
});

test('a conversation is only taken from a tab on the site it claims, and settings only from the popup', async () => {
  const { p, b } = await signedIn();
  const refused = { ok: false, yes: false, why: 'not-allowed' };
  assert.deepEqual(await b.send({ type: 'ship', session: session(3) }, { tab: { url: 'https://evil.example/chat/x' } }), refused);
  assert.deepEqual(await b.send({ type: 'ship', session: session(3) }, { tab: { url: 'https://chatgpt.com/c/x' } }), refused);
  assert.deepEqual(await b.send({ type: 'ship', session: session(3) }, {}), refused);
  assert.deepEqual(await b.send({ type: 'ship', session: session(3, { site: 'evil.example' }) }, { tab: { url: 'https://evil.example/' } }), refused);
  assert.deepEqual(await b.send({ type: 'ship', session: session(3) }, { tab: { url: 'https://claude.ai.evil.example/' } }), refused);
  assert.equal(p.ingests().length, 0);
  for (const type of ['sign-out', 'set-paused', 'state', 'sign-in'])
    assert.deepEqual(await b.send({ type, on: true }, { tab: { url: 'https://claude.ai/chat/x' } }), refused);
  assert.equal((await b.send({ type: 'state' })).signed_in, true);
  assert.equal((await b.send({ type: 'ship', session: session(3) })).ok, true);
});

test('sign-in refuses an approval address that is not Praxos', async () => {
  for (const bad of ['http://app.mypraxos.com/?overlay=link-device', 'https://mypraxos.com.evil.example/', 'javascript:alert(1)', '']) {
    const calls = [];
    const b = boot(async (url, init) => { calls.push(url); return json(200, { success: true, data: { user_code: 'ABCD-1234', poll_secret: 'x', verification_url: bad, expires_in: 600 } }); });
    const r = await b.send({ type: 'sign-in' });
    assert.equal(r.ok, false, bad);
    assert.equal((await b.send({ type: 'state' })).link, null);
  }
});
