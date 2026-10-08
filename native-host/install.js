'use strict';
// Registers the Claude Code bridge as a Chrome/Edge native messaging host for this user.
// Usage: node native-host/install.js [--claude <path>] [--model <alias>] [--extension-id <id>] [--uninstall]
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const NAME = 'com.lexitrail.claude', home = os.homedir();
const args = process.argv.slice(2);
function option(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }

function locations() {
  if (process.platform === 'darwin') {
    const support = path.join(home, 'Library/Application Support');
    return { install: path.join(support, 'LexiTrail/claude-host'),
      browsers: ['Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome Canary', 'Chromium', 'Microsoft Edge'].map(b => path.join(support, b)) };
  }
  if (process.platform === 'linux') {
    const config = process.env.XDG_CONFIG_HOME || path.join(home, '.config'), data = process.env.XDG_DATA_HOME || path.join(home, '.local/share');
    return { install: path.join(data, 'lexitrail/claude-host'),
      browsers: ['google-chrome', 'google-chrome-beta', 'chromium', 'microsoft-edge'].map(b => path.join(config, b)) };
  }
  throw Error('目前支持 macOS 与 Linux。Windows 需要写入注册表，暂未提供。');
}

// Chrome derives an extension ID from the SHA-256 of the manifest public key, mapping hex 0-f to a-p.
function extensionId() {
  if (option('--extension-id')) {
    if (!/^[a-p]{32}$/.test(option('--extension-id'))) throw Error('扩展 ID 应为 32 个 a-p 字母。');
    return option('--extension-id');
  }
  const manifest = [path.join(__dirname, '../extension/manifest.json'), path.join(__dirname, '../manifest.json')].find(fs.existsSync);
  const key = manifest && JSON.parse(fs.readFileSync(manifest, 'utf8')).key;
  if (!key) throw Error('找不到带 key 的 manifest.json，请用 --extension-id 指定扩展 ID。');
  const hash = crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
  return [...hash].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

function executable(file) {
  try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
}
// Chrome starts hosts with a minimal PATH, so command locations are resolved now and stored.
// The login shell's path (e.g. a Homebrew symlink) survives upgrades better than a versioned real path.
function shellCommand(name) {
  try {
    const found = execFileSync(process.env.SHELL || '/bin/sh', ['-lc', `command -v ${name}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').pop();
    if (found && path.isAbsolute(found) && executable(found)) return found;
  } catch {}
  return '';
}
function nodePath() {
  const found = shellCommand('node');
  try { if (found && fs.realpathSync(found) === fs.realpathSync(process.execPath)) return found; } catch {}
  return process.execPath;
}
function claudePath() {
  const given = option('--claude');
  if (given) { if (!executable(given)) throw Error(`${given} 不是可执行文件。`); return path.resolve(given); }
  const found = shellCommand('claude');
  if (found) return found;
  const known = [path.join(home, '.local/bin/claude'), path.join(home, '.claude/local/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'].find(executable);
  if (known) return known;
  throw Error('找不到 claude 命令，请先安装 Claude Code，或用 --claude 指定路径。');
}

function quote(value) { return `'${value.replaceAll("'", `'\\''`)}'`; }

function install() {
  const { install: folder, browsers } = locations(), id = extensionId(), claude = claudePath(), node = nodePath(), model = option('--model') || 'haiku';
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(model)) throw Error('模型名称无效。');
  fs.mkdirSync(folder, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'host.js'), path.join(folder, 'host.js'));
  fs.writeFileSync(path.join(folder, 'config.json'), JSON.stringify({ claude, model }, null, 2) + '\n');
  const launcher = path.join(folder, 'lexitrail-claude');
  const pathPrefix = [...new Set([path.dirname(node), path.dirname(claude)])].map(quote).join(':');
  fs.writeFileSync(launcher, `#!/bin/sh\nPATH=${pathPrefix}:"$PATH"\nexport PATH\nexec ${quote(node)} ${quote(path.join(folder, 'host.js'))} "$@"\n`, { mode: 0o755 });
  fs.chmodSync(launcher, 0o755);
  const manifest = JSON.stringify({ name: NAME, description: 'LexiTrail Claude Code bridge', path: launcher, type: 'stdio',
    allowed_origins: [`chrome-extension://${id}/`] }, null, 2) + '\n';
  let installed = browsers.filter(fs.existsSync);
  if (!installed.length) installed = [browsers[0]];
  for (const browser of installed) {
    fs.mkdirSync(path.join(browser, 'NativeMessagingHosts'), { recursive: true });
    fs.writeFileSync(path.join(browser, 'NativeMessagingHosts', `${NAME}.json`), manifest);
  }
  console.log(`Claude Code 桥接已安装：${folder}`);
  console.log(`claude：${claude}\nnode：${node}\n模型：${model}\n扩展 ID：${id}`);
  console.log(`已注册浏览器：\n${installed.map(b => '  ' + b).join('\n')}`);
  console.log('下一步：在扩展管理页重新加载 LexiTrail，然后在设置页的“AI 释义”中选择 Claude Code 并点击检测连接。');
}

function uninstall() {
  const { install: folder, browsers } = locations();
  for (const browser of browsers) fs.rmSync(path.join(browser, 'NativeMessagingHosts', `${NAME}.json`), { force: true });
  fs.rmSync(folder, { recursive: true, force: true });
  console.log('Claude Code 桥接已移除。');
}

try { if (args.includes('--uninstall')) uninstall(); else install(); }
catch (error) { console.error(error.message); process.exitCode = 1; }
