'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../extension/core');
const API = require('../extension/api');
test('Flash request uses bounded context, JSON output and disabled thinking', async () => {
  const original = global.fetch; let request;
  global.fetch = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '{"meaning":"小径","example":"We walked along the trail."}' } }] }) };
  };
  try {
    await API.deepseek('trail', 'x'.repeat(900), 'fixture');
    assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
    assert.equal(request.body.model, 'deepseek-flash'); assert.equal(request.body.thinking.type, 'disabled');
    assert.equal(request.body.max_tokens, 320); assert.equal(request.body.response_format.type, 'json_object');
    assert.equal(JSON.parse(request.body.messages[1].content).context.length, 300);
    assert.equal(request.options.credentials, 'omit'); assert(request.options.signal);
  } finally { global.fetch = original; }
});
test('API errors are actionable and omit response bodies and credentials', async () => {
  const original = global.fetch;
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ credential: 'private' }) });
  try { await assert.rejects(API.deepseek('trail', '', 'fixture'), { message: 'Key 无效，请在设置中更新。' }); }
  finally { global.fetch = original; }
});
test('Claude Code lookup sends only a validated word and bounded context to the fixed native host', async () => {
  const original = global.chrome; let request;
  global.chrome = { runtime: { sendNativeMessage: async (host, message) => {
    request = { host, message };
    return { ok: true, data: { partOfSpeech: 'noun', meaning: '小径', definition: 'A path.', example: 'We walked along the trail.', exampleTranslation: '我们沿着小径走。' } };
  } } };
  try {
    const result = await API.claudeCode('trail', 'x'.repeat(900));
    assert.equal(request.host, 'com.lexitrail.claude'); assert.deepEqual(Object.keys(request.message), ['type', 'word', 'context']);
    assert.equal(request.message.type, 'LOOKUP'); assert.equal(request.message.context.length, 300);
    assert.equal(result.meaning, '小径'); assert.equal(result.example, 'We walked along the trail.');
  } finally { global.chrome = original; }
});
test('Claude Code bridge errors distinguish a missing bridge, host failures and incomplete results', async () => {
  const original = global.chrome;
  const respond = behaviour => { global.chrome = { runtime: { sendNativeMessage: behaviour } }; };
  try {
    respond(async () => { throw new Error('Specified native messaging host not found.'); });
    await assert.rejects(API.claudeCode('trail', ''), { message: /native-host\/install\.js/ });
    respond(async () => { throw new Error('Access to the specified native messaging host is forbidden.'); });
    await assert.rejects(API.claudeCode('trail', ''), { message: /未授权/ });
    respond(async () => ({ ok: false, error: 'Claude Code：Not logged in · Please run /login' }));
    await assert.rejects(API.claudeCode('trail', ''), { message: 'Claude Code：Not logged in · Please run /login' });
    respond(async () => ({ ok: true, data: { meaning: '小径' } }));
    await assert.rejects(API.claudeCode('trail', ''), { message: /缺少必要内容/ });
    respond(async () => ({ ok: true, data: { version: '2.1.258 (Claude Code)', model: 'haiku' } }));
    assert.deepEqual(await API.claudeCodeStatus(), { version: '2.1.258 (Claude Code)', model: 'haiku' });
  } finally { global.chrome = original; }
});
