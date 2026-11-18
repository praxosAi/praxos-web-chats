// node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const C = createRequire(import.meta.url)('../lib/convert.js');

const ROOT = '00000000-0000-4000-8000-000000000000';
const claude = () => ({
  uuid: 'c1', name: '  Plan  the\nlaunch ', model: 'claude-x', updated_at: '2026-11-01T10:05:00.000000Z', is_temporary: false,
  chat_messages: [
    { uuid: 'm1', sender: 'human', index: 0, created_at: '2026-11-01T10:00:00.000000Z', parent_message_uuid: ROOT,
      content: [{ type: 'text', text: 'Draft a plan' }], attachments: [{ file_name: 'notes.txt', extracted_content: 'SECRET BODY' }], files: [] },
    { uuid: 'm2', sender: 'assistant', index: 1, created_at: '2026-11-01T10:00:05.000000Z', parent_message_uuid: 'm1',
      content: [{ type: 'thinking', thinking: 'private reasoning' },
                { type: 'tool_use', id: 't1', name: 'web_search', input: { query: 'x' } },
                { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'PAGE TEXT' }] }] },
    { uuid: 'm3', sender: 'assistant', index: 2, created_at: '2026-11-01T10:00:09.000000Z', parent_message_uuid: 'm2',
      content: [{ type: 'text', text: 'Here is the plan.' },
                { type: 'tool_use', id: 't2', name: 'artifacts', input: { command: 'create', id: 'a', title: 'Launch plan', content: '# Plan\n1. Ship' } }] },
    { uuid: 'm4', sender: 'human', index: 1, created_at: '2026-11-01T10:01:00.000000Z', parent_message_uuid: ROOT,
      content: [{ type: 'text', text: 'Draft a short plan' }] },   // an edited first message: a second branch
  ],
});

test('claude: text, artifacts and attachment names are kept; reasoning and tool results are not', () => {
  const s = C.claudeToSession(claude());
  assert.equal(s.session_id, 'claudeai-c1');
  assert.equal(s.site, 'claude.ai');
  assert.equal(s.title, 'Plan the launch');
  assert.equal(s.temporary, false);
  const all = JSON.stringify(s.messages);
  assert.ok(!all.includes('private reasoning') && !all.includes('PAGE TEXT') && !all.includes('SECRET BODY'));
  assert.deepEqual(s.messages.map(m => m.uuid), ['web:claude.ai:m1', 'web:claude.ai:m3', 'web:claude.ai:m4']);
  assert.equal(s.messages[0].text, 'Draft a plan\n\n[attachment: notes.txt]');
  assert.match(s.messages[1].text, /Here is the plan\.\n\n\[artifact: Launch plan\]\n# Plan/);
  assert.equal(s.messages[1].model, 'claude-x');
  assert.equal(s.messages[1].tool_call_count, 1);
  assert.equal(s.messages[0].model, undefined);
});

test('claude: a dropped message does not break the chain, and both branches keep the root', () => {
  const s = C.claudeToSession(claude());
  const by = Object.fromEntries(s.messages.map(m => [m.uuid, m]));
  assert.equal(by['web:claude.ai:m1'].parent_uuid, null);
  assert.equal(by['web:claude.ai:m3'].parent_uuid, 'web:claude.ai:m1');   // m2 had only reasoning and a tool call
  assert.equal(by['web:claude.ai:m4'].parent_uuid, null);
});

test('claude: files the assistant wrote keep their body, other tool calls only count', () => {
  const conv = claude();
  conv.chat_messages[2].content = [
    { type: 'text', text: 'Done.' },
    { type: 'tool_use', id: 'a', name: 'create_file', input: { path: '/out/plan.md', file_text: '# Plan A', description: 'd' } },
    { type: 'tool_use', id: 'b', name: 'Write', input: { file_path: '/out/b.md', content: '# Plan B' } },
    { type: 'tool_use', id: 'c', name: 'bash_tool', input: { command: 'cat secrets', description: 'x' } },
  ];
  const m = C.claudeToSession(conv).messages[1];
  assert.equal(m.text, 'Done.\n\n[file: /out/plan.md]\n# Plan A\n\n[file: /out/b.md]\n# Plan B');
  assert.equal(m.tool_call_count, 3);
});

test('claude: a temporary chat is marked, so it is never saved', () => {
  assert.equal(C.claudeToSession({ ...claude(), is_temporary: true }).temporary, true);
});

test('claude: the shape the ingest expects', () => {
  for (const m of C.claudeToSession(claude()).messages) {
    assert.deepEqual(Object.keys(m).filter(k => k !== 'model').sort(), ['parent_uuid', 'role', 'text', 'tool_call_count', 'ts', 'uuid']);
    assert.ok(['user', 'assistant'].includes(m.role));
    assert.match(m.ts, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  }
});

const chatgpt = () => ({
  conversation_id: 'g1', title: 'Regex help', create_time: 1793000000, update_time: 1793000100,
  mapping: {
    root: { id: 'root', parent: null, message: null },
    sys: { id: 'sys', parent: 'root', message: { id: 'sys', author: { role: 'system' }, content: { content_type: 'text', parts: [''] }, metadata: { is_visually_hidden_from_conversation: true } } },
    u1: { id: 'u1', parent: 'sys', message: { id: 'u1', author: { role: 'user' }, create_time: 1793000001, content: { content_type: 'text', parts: ['Match a date'] }, metadata: {} } },
    call: { id: 'call', parent: 'u1', message: { id: 'call', author: { role: 'assistant' }, recipient: 'python', create_time: 1793000002, content: { content_type: 'code', text: 'print(1)' }, metadata: {} } },
    tool: { id: 'tool', parent: 'call', message: { id: 'tool', author: { role: 'tool' }, create_time: 1793000003, content: { content_type: 'execution_output', text: '1' }, metadata: {} } },
    a1: { id: 'a1', parent: 'tool', message: { id: 'a1', author: { role: 'assistant' }, recipient: 'all', create_time: 1793000004, content: { content_type: 'text', parts: ['Use \\d{4}'] }, metadata: { model_slug: 'gpt-x' } } },
    u2: { id: 'u2', parent: 'a1', message: { id: 'u2', author: { role: 'user' }, create_time: null, content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'file://x' }, 'and this one?'] }, metadata: {} } },
  },
});

test('chatgpt: only what the person and the assistant said, tool calls counted', () => {
  const s = C.chatgptToSession(chatgpt());
  assert.equal(s.session_id, 'chatgpt-g1');
  assert.equal(s.title, 'Regex help');
  assert.deepEqual(s.messages.map(m => [m.role, m.text]), [['user', 'Match a date'], ['assistant', 'Use \\d{4}'], ['user', '[image]\n\nand this one?']]);
  const a = s.messages[1];
  assert.equal(a.parent_uuid, 'web:chatgpt.com:u1');
  assert.equal(a.tool_call_count, 1);
  assert.equal(a.model, 'gpt-x');
  assert.equal(s.messages[0].parent_uuid, null);
  assert.equal(s.messages[2].ts, a.ts);            // no time of its own: its parent's
});

test('what to send: everything first, then only what is new', () => {
  const s = C.claudeToSession(claude());
  const first = C.selectToShip(s.messages, null);
  assert.equal(first.send.length, 3);
  assert.equal(C.selectToShip(s.messages, first.state).send.length, 0);
  const more = s.messages.concat([{ uuid: 'web:claude.ai:m5', parent_uuid: 'web:claude.ai:m4', ts: '2026-11-01T10:02:00.000Z', role: 'assistant', text: 'Short plan.', tool_call_count: 0 }]);
  const second = C.selectToShip(more, first.state);
  assert.deepEqual(second.send.map(m => m.uuid), ['web:claude.ai:m5']);
  assert.equal(second.send[0].amended, undefined);
  assert.equal(second.state.last_ts, '2026-11-01T10:02:00.000Z');
});

test('what to send: a reply caught mid-stream goes again, marked amended', () => {
  const s = C.claudeToSession(claude());
  const first = C.selectToShip(s.messages, null);
  const grown = s.messages.map(m => m.uuid === 'web:claude.ai:m3' ? { ...m, text: m.text + ' And more.' } : m);
  const again = C.selectToShip(grown, first.state);
  assert.deepEqual(again.send.map(m => [m.uuid, m.amended]), [['web:claude.ai:m3', true]]);
  assert.equal(C.selectToShip(grown, again.state).send.length, 0);
});

test('what to send: old messages outside the recent few are never re-sent', () => {
  const msgs = Array.from({ length: 30 }, (_, i) => ({ uuid: 'u' + i, parent_uuid: null, role: 'user', text: 't' + i, tool_call_count: 0,
                                                       ts: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() }));
  const st = C.selectToShip(msgs, null).state;
  assert.equal(Object.keys(st.tail).length, 8);
  const edited = msgs.map((m, i) => i === 2 ? { ...m, text: 'changed' } : m);
  assert.equal(C.selectToShip(edited, st).send.length, 0);
});

test('batches respect both limits', () => {
  const msgs = Array.from({ length: 10 }, (_, i) => ({ uuid: 'u' + i, text: 'x'.repeat(1000) }));
  assert.equal(C.batches(msgs, 4, 1e9).length, 3);
  assert.ok(C.batches(msgs, 100, 2500).every(b => b.length <= 2));
  assert.equal(C.batches([], 4, 100).length, 0);
});

test('a very long message is cut, and says so', () => {
  const conv = claude();
  conv.chat_messages[0].content[0].text = 'y'.repeat(70000);
  const m = C.claudeToSession(conv).messages[0];
  assert.ok(m.text.length < 61000 && /\[cut: \d+ more characters\]/.test(m.text));
});
