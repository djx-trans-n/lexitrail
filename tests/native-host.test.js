'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const source = path.join(__dirname, '../native-host');

// A stand-in for the claude CLI: records its arguments, stdin and environment, then answers by word.
const FAKE = `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
const input = fs.readFileSync(0, 'utf8');
fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ args: process.argv.slice(2), input, thinking: process.env.MAX_THINKING_TOKENS, cwd: process.cwd() }));
const word = JSON.parse(input).word;
const entry = { partOfSpeech: 'noun', meaning: '小径', definition: 'A path.', example: 'We walked along the trail.', exampleTranslation: '我们沿着小径走。', extra: 'dropped' };
if (word === 'failing') console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' }));
else if (word === 'garbled') console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'No dictionary entry.' }));
else console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: word === 'fenced' ? '\`\`\`json\\n' + JSON.stringify(entry) + '\\n\`\`\`' : JSON.stringify(entry) }));
`;

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexitrail-host-'));
  fs.copyFileSync(path.join(source, 'host.js'), path.join(dir, 'host.js'));
  fs.writeFileSync(path.join(dir, 'claude'), FAKE, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ claude: path.join(dir, 'claude'), model: 'haiku' }));
  return dir;
}
function frame(value) {
  const body = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)), header = Buffer.alloc(4);
  header.writeUInt32LE(body.length); return Buffer.concat([header, body]);
}
// Speaks Chrome's protocol: length-prefixed JSON in both directions.
function exchange(dir, messages) {
  return new Promise((resolve, reject) => {
    const host = spawn(process.execPath, [path.join(dir, 'host.js'), 'chrome-extension://fixture/'], { env: { ...process.env, FAKE_LOG: path.join(dir, 'log.json') } });
    let output = Buffer.alloc(0);
    host.stdout.on('data', chunk => { output = Buffer.concat([output, chunk]); });
    host.on('error', reject);
    host.on('close', () => {
      const replies = [];
      while (output.length >= 4) { const length = output.readUInt32LE(0); replies.push(JSON.parse(output.subarray(4, 4 + length))); output = output.subarray(4 + length); }
      resolve(replies);
    });
    host.stdin.end(Buffer.concat(messages.map(frame)));
  });
}

test('bridge runs claude with fixed flags, no tools, no thinking and only the word and bounded context', async () => {
  const dir = setup();
  const [reply] = await exchange(dir, [{ type: 'LOOKUP', word: 'Trail', context: 'x'.repeat(900), prompt: 'ignored', args: ['--dangerously-skip-permissions'] }]);
  assert.deepEqual(reply, { ok: true, data: { partOfSpeech: 'noun', meaning: '小径', definition: 'A path.', example: 'We walked along the trail.', exampleTranslation: '我们沿着小径走。' } });
  const log = JSON.parse(fs.readFileSync(path.join(dir, 'log.json'), 'utf8'));
  assert.deepEqual(JSON.parse(log.input), { word: 'trail', context: 'x'.repeat(300) });
  assert.equal(log.args[log.args.indexOf('--tools') + 1], ''); assert.equal(log.args[log.args.indexOf('--model') + 1], 'haiku');
  for (const flag of ['-p', '--safe-mode', '--strict-mcp-config', '--no-session-persistence', '--system-prompt']) assert(log.args.includes(flag), flag);
  assert(!log.args.includes('--dangerously-skip-permissions')); assert(!log.args.some(arg => arg.includes('x'.repeat(10))));
  assert.equal(log.thinking, '0'); assert.equal(fs.realpathSync(log.cwd), fs.realpathSync(dir));
});
test('bridge accepts fenced JSON, reports CLI errors, and rejects invalid requests without running claude', async () => {
  const dir = setup();
  const replies = await exchange(dir, [{ type: 'LOOKUP', word: 'fenced' }, { type: 'LOOKUP', word: 'failing' }, { type: 'LOOKUP', word: 'garbled' },
    { type: 'LOOKUP', word: 'two words' }, { type: 'SHELL', command: 'ls' }, '{broken', { type: 'PING' }]);
  assert.equal(replies[0].data.meaning, '小径');
  assert.deepEqual(replies.slice(1, 6), [{ ok: false, error: 'Claude Code：Not logged in · Please run /login' }, { ok: false, error: 'Claude Code 返回的释义格式无效，请重试。' },
    { ok: false, error: '请选择一个英文单词。' }, { ok: false, error: '未知请求。' }, { ok: false, error: '请求格式无效。' }]);
  assert.deepEqual(replies[6], { ok: true, data: { version: '9.9.9', model: 'haiku' } });
});
test('bridge reports a missing claude binary', async () => {
  const dir = setup(); fs.rmSync(path.join(dir, 'claude'));
  const [reply] = await exchange(dir, [{ type: 'LOOKUP', word: 'trail' }]);
  assert.equal(reply.ok, false); assert.match(reply.error, /找不到 claude 命令/);
});
test('installer registers the host for the extension identity and uninstall removes it', { skip: !['darwin', 'linux'].includes(process.platform) }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lexitrail-home-')), dir = setup();
  const browser = process.platform === 'darwin' ? path.join(home, 'Library/Application Support/Google/Chrome') : path.join(home, '.config/google-chrome');
  fs.mkdirSync(browser, { recursive: true });
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: '', XDG_DATA_HOME: '' };
  execFileSync(process.execPath, [path.join(source, 'install.js'), '--claude', path.join(dir, 'claude')], { env, stdio: 'pipe' });
  const registration = JSON.parse(fs.readFileSync(path.join(browser, 'NativeMessagingHosts/com.lexitrail.claude.json'), 'utf8'));
  assert.equal(registration.name, 'com.lexitrail.claude'); assert.equal(registration.type, 'stdio');
  assert.deepEqual(registration.allowed_origins, ['chrome-extension://pabcjgpefkpmodichjomkgiflicagkec/']);
  fs.accessSync(registration.path, fs.constants.X_OK);
  const installed = path.dirname(registration.path);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(installed, 'config.json'), 'utf8')), { claude: path.join(dir, 'claude'), model: 'haiku' });
  assert.throws(() => execFileSync(process.execPath, [path.join(source, 'install.js'), '--claude', path.join(dir, 'claude'), '--model', 'haiku; rm'], { env, stdio: 'pipe' }));
  execFileSync(process.execPath, [path.join(source, 'install.js'), '--uninstall'], { env, stdio: 'pipe' });
  assert(!fs.existsSync(path.join(browser, 'NativeMessagingHosts/com.lexitrail.claude.json'))); assert(!fs.existsSync(installed));
});
