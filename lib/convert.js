// Praxos for web chats: turning a site's conversation into Praxos messages.
// Pure functions, shared by the content script, the service worker and the
// tests (tests/extension). No DOM, no network.
(function (root) {
  'use strict';

  var TEXT_CAP = 60000;        // one message's text
  var ARTIFACT_CAP = 20000;    // one artifact's body inside a message
  var TAIL = 8;                // how many recent messages are re-checked for a changed text
  var CLAUDE_ROOT = '00000000-0000-4000-8000-000000000000';

  function cap(text, n) {
    text = String(text == null ? '' : text);
    return text.length > n ? text.slice(0, n) + '\n… [cut: ' + (text.length - n) + ' more characters]' : text;
  }

  // An ISO time from an ISO string or epoch seconds; '' when there is none.
  function iso(v) {
    if (typeof v === 'number' && isFinite(v) && v > 0) return new Date(v * 1000).toISOString();
    if (typeof v === 'string' && v) {
      var d = new Date(v);
      return isNaN(d.getTime()) ? '' : d.toISOString();
    }
    return '';
  }

  // A short stable fingerprint of a message's text (djb2), to notice a text that changed in place.
  function hash(text) {
    var h = 5381;
    for (var i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36) + ':' + text.length;
  }

  // ---- claude.ai ----------------------------------------------------------
  // GET /api/organizations/{org}/chat_conversations/{id}?tree=True&rendering_mode=messages
  // -> {uuid, name, model, updated_at, is_temporary, chat_messages: [{uuid, sender, content: [blocks],
  //     text, created_at, parent_message_uuid, attachments, files}]}. Every branch of the tree is kept.

  function claudeText(m) {
    var parts = [], tools = 0;
    (m.content || []).forEach(function (b) {
      if (!b || typeof b !== 'object') return;
      if (b.type === 'text' && b.text) parts.push(b.text);
      else if (b.type === 'tool_use') {
        tools += 1;
        var input = b.input || {};
        // A document the assistant wrote is the work itself: its body is kept. Three shapes seen on the
        // live site (2026-11): artifacts {title, content}, create_file {path, file_text}, Write {file_path, content}.
        var body = b.name === 'create_file' ? input.file_text : (b.name === 'artifacts' || b.name === 'Write') ? input.content : null;
        if (typeof body === 'string' && body) {
          var label = b.name === 'artifacts' ? 'artifact: ' + (input.title || input.id || 'untitled')
                                             : 'file: ' + (input.path || input.file_path || 'untitled');
          parts.push('[' + label + ']\n' + cap(body, ARTIFACT_CAP));
        }
      } else if (b.type === 'image') parts.push('[image]');
      // thinking and tool_result blocks are left out: not what was said, and tool results are other people's text.
    });
    if (!parts.length && typeof m.text === 'string' && m.text) parts.push(m.text);
    (m.attachments || []).forEach(function (a) { if (a && a.file_name) parts.push('[attachment: ' + a.file_name + ']'); });
    (m.files || []).forEach(function (f) { if (f && f.file_name) parts.push('[file: ' + f.file_name + ']'); });
    return { text: parts.join('\n\n').trim(), tools: tools };
  }

  function claudeToSession(conv) {
    var raw = Array.isArray(conv && conv.chat_messages) ? conv.chat_messages : [];
    var byId = {};
    raw.forEach(function (m) { if (m && m.uuid) byId[m.uuid] = m; });
    var kept = {}, out = [];
    raw.forEach(function (m) {
      if (!m || !m.uuid || (m.sender !== 'human' && m.sender !== 'assistant')) return;
      var t = claudeText(m);
      var ts = iso(m.created_at);
      if (!t.text || !ts) return;
      kept[m.uuid] = true;
      out.push({ _id: m.uuid, _parent: m.parent_message_uuid, _i: typeof m.index === 'number' ? m.index : 0,
                 uuid: 'web:claude.ai:' + m.uuid, ts: ts, role: m.sender === 'human' ? 'user' : 'assistant',
                 text: cap(t.text, TEXT_CAP), tool_call_count: t.tools,
                 model: m.sender === 'assistant' && conv.model ? String(conv.model) : null });
    });
    out.forEach(function (msg) {
      // The nearest kept ancestor: a dropped (empty) message must not break the chain.
      var p = msg._parent, hops = 0;
      while (p && p !== CLAUDE_ROOT && !kept[p] && byId[p] && hops++ < 10000) p = byId[p].parent_message_uuid;
      msg.parent_uuid = p && kept[p] ? 'web:claude.ai:' + p : null;
    });
    return finish('claude.ai', 'claudeai-' + conv.uuid, conv.name, iso(conv.updated_at), !!conv.is_temporary, out);
  }

  // ---- chatgpt.com --------------------------------------------------------
  // GET /backend-api/conversation/{id} -> {conversation_id, title, update_time, mapping: {id: {id, parent,
  //   message: {id, author: {role}, recipient, create_time, content: {content_type, parts}, metadata}}}}.

  function chatgptText(message) {
    var c = message.content || {};
    if (c.content_type !== 'text' && c.content_type !== 'multimodal_text') return '';
    var parts = [];
    (c.parts || []).forEach(function (p) {
      if (typeof p === 'string') { if (p) parts.push(p); }
      else if (p && typeof p === 'object') {
        if (typeof p.text === 'string' && p.text) parts.push(p.text);
        else if (p.content_type === 'image_asset_pointer') parts.push('[image]');
      }
    });
    return parts.join('\n\n').trim();
  }

  function chatgptToSession(conv) {
    var mapping = (conv && conv.mapping) || {};
    var kept = {}, out = [];
    Object.keys(mapping).forEach(function (id) {
      var node = mapping[id], m = node && node.message;
      if (!m || !m.author) return;
      var role = m.author.role;
      if (role !== 'user' && role !== 'assistant') return;
      var meta = m.metadata || {};
      if (meta.is_visually_hidden_from_conversation) return;
      if (role === 'assistant' && m.recipient && m.recipient !== 'all') return;   // a call to a tool, not a reply
      var text = chatgptText(m);
      if (!text) return;
      kept[id] = true;
      out.push({ _id: id, _parent: node.parent, _i: 0, uuid: 'web:chatgpt.com:' + id,
                 ts: iso(m.create_time), role: role, text: cap(text, TEXT_CAP), tool_call_count: 0,
                 model: role === 'assistant' && meta.model_slug ? String(meta.model_slug) : null });
    });
    var byOut = {};
    out.forEach(function (msg) { byOut[msg._id] = msg; });
    out.forEach(function (msg) {
      var p = msg._parent, hops = 0, tools = 0;
      while (p && !kept[p] && mapping[p] && hops++ < 10000) {
        var pm = mapping[p].message;
        if (pm && pm.author && pm.author.role === 'assistant' && pm.recipient && pm.recipient !== 'all') tools += 1;
        p = mapping[p].parent;
      }
      msg.parent_uuid = p && kept[p] ? 'web:chatgpt.com:' + p : null;
      if (msg.role === 'assistant') msg.tool_call_count = tools;
    });
    // A message without its own time takes its parent's, else the conversation's.
    var fallback = iso(conv.create_time) || iso(conv.update_time);
    out.forEach(function (msg) {
      var p = msg._parent, hops = 0;
      while (!msg.ts && p && hops++ < 10000) {
        if (byOut[p] && byOut[p].ts) msg.ts = byOut[p].ts;
        p = mapping[p] ? mapping[p].parent : null;
      }
      if (!msg.ts) msg.ts = fallback;
    });
    out = out.filter(function (msg) { return !!msg.ts; });
    var id = conv.conversation_id || conv.id;
    return finish('chatgpt.com', 'chatgpt-' + id, conv.title, iso(conv.update_time), false, out);
  }

  function finish(site, sessionId, title, updated, temporary, messages) {
    messages.sort(function (a, b) { return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a._i - b._i; });
    messages.forEach(function (m) { delete m._id; delete m._parent; delete m._i; if (!m.model) delete m.model; });
    return { site: site, session_id: sessionId, title: (title || '').replace(/\s+/g, ' ').trim().slice(0, 300),
             updated: updated, temporary: temporary, messages: messages };
  }

  // ---- what to send -------------------------------------------------------
  // state = {last_ts, tail: {uuid: hash}} for one conversation (null: nothing sent yet).
  // New messages are those after last_ts; one of the last few already sent whose text has
  // changed since (a reply caught mid-stream) goes again, marked amended so the server
  // replaces it. Returns {send, state}: the state to store once every batch is accepted.
  function selectToShip(messages, state) {
    var last = (state && state.last_ts) || '';
    var tail = (state && state.tail) || {};
    var send = [];
    messages.forEach(function (m) {
      var h = hash(m.text);
      if (Object.prototype.hasOwnProperty.call(tail, m.uuid)) {
        if (tail[m.uuid] !== h) send.push(Object.assign({}, m, { amended: true }));
      } else if (!last || m.ts >= last) {
        send.push(m);
      }
    });
    var newTail = {};
    messages.slice(-TAIL).forEach(function (m) { newTail[m.uuid] = hash(m.text); });
    var maxTs = messages.length ? messages[messages.length - 1].ts : last;
    return { send: send, state: { last_ts: maxTs > last ? maxTs : last, tail: newTail } };
  }

  // Batches under the ingest's limits (messages per request, bytes per request).
  function batches(messages, maxCount, maxBytes) {
    var out = [], cur = [], size = 0;
    messages.forEach(function (m) {
      var s = JSON.stringify(m).length;
      if (cur.length && (cur.length >= maxCount || size + s > maxBytes)) { out.push(cur); cur = []; size = 0; }
      cur.push(m); size += s;
    });
    if (cur.length) out.push(cur);
    return out;
  }

  var api = { claudeToSession: claudeToSession, chatgptToSession: chatgptToSession,
              selectToShip: selectToShip, batches: batches, hash: hash, iso: iso };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PraxosConvert = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
