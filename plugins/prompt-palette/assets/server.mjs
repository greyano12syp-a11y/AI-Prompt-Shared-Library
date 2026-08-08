#!/usr/bin/env node
// AI 提示词共享库本地服务：HTTP 打开工作台与提示词深链。
// 特性：真实端口健康检查、PID/版本标识、单实例锁、旧实例回收、心跳。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_HTML = path.join(__dirname, 'AI提示词工作台.html');
const CLAUDE_HTML = path.join(__dirname, 'claude-client.html');
const LIB_BASE = path.join(__dirname, 'libs');
// 允许公开访问的本地文档解析库（白名单；仅文件名生效，杜绝任何路径穿越）
const LIB_ALLOW = new Set(['mammoth.browser.min.js', 'xlsx.full.min.js', 'pdf.min.js', 'pdf.worker.min.js']);
const VERSION = path.basename(path.dirname(__dirname)) || 'dev';
const PID = process.pid;

/**
 * 从命令行参数取 <name> 后面的值。
 * @param {string} name 参数名（如 "--port"）
 * @returns {string|null} 参数值；缺省返回 null
 */
function argVal(name) {
  const args = process.argv.slice(2);
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}
function defaultDataDir() {
  if (process.env.PP_DATA_DIR) return process.env.PP_DATA_DIR;
  if (process.platform === 'win32' || fs.existsSync(path.join(os.homedir(), 'Documents'))) {
    return path.join(os.homedir(), 'Documents', 'Codex', 'prompt-palette-data');
  }
  return path.join(os.homedir(), '.prompt-palette');
}
const DATA_BASE = path.normalize(argVal('--data') || defaultDataDir());
const PORT = parseInt(argVal('--port'), 10) || 1190;
// Claude Code 权限配置文件（工作台“权限模式”三个选项写入这里）
const PERM_FILE = path.normalize(process.env.PP_CLAUDE_SETTINGS ||
  path.join(os.homedir(), 'plugins', 'prompt-palette', '.claude', 'settings.json'));
const PERM_MODES = { ask: 'default', auto: 'acceptEdits', full: 'bypassPermissions' };
// CC Switch 用量数据库（只读；环境变量可覆盖路径）
const CCSWITCH_DB = path.normalize(process.env.PP_CCSWITCH_DB ||
  path.join(os.homedir(), '.cc-switch', 'cc-switch.db'));
const USD2CNY = 7.2;
// Claude Code CLI（可环境变量 PP_CLAUDE_BIN 覆盖）：Windows 用 npm 全局 exe，macOS/Linux 用 PATH 中的 claude
const CLAUDE_BIN = process.env.PP_CLAUDE_BIN || (process.platform === 'win32'
  ? path.join('E:', 'npm_global', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
  : 'claude');
const CLAUDE_DEFAULT_CWD = path.join(os.homedir(), 'plugins', 'prompt-palette');
const claudeSessions = new Map();
function claudeSpawn(cwd) {
  const env = Object.assign({}, process.env, { HOME: os.homedir(), USERPROFILE: os.homedir() });
  delete env.CLAUDE_CONFIG_DIR;
  // 不强制跳过权限：遵循 ~/.claude 与项目 .claude 的 defaultMode（当前 acceptEdits），
  // 用户可在客户端/工作台选择“完全全自动”后由配置生效。
  return spawn(CLAUDE_BIN, [
    '-p',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--verbose',
    '--max-turns', '40'
  ], { cwd: cwd, env: env, stdio: ['pipe', 'pipe', 'pipe'] });
}
function claudeBroadcast(ses, evt) {
  const payload = 'data: ' + JSON.stringify(evt) + '\n\n';
  ses.listeners.forEach(res => { try { res.write(payload); } catch (e) {} });
}
function claudeHandleData(ses, chunk) {
  ses.buffer += chunk;
  let i;
  while ((i = ses.buffer.indexOf('\n')) >= 0) {
    const line = ses.buffer.slice(0, i).trim();
    ses.buffer = ses.buffer.slice(i + 1);
    if (!line) continue;
    let evt = null;
    try { evt = JSON.parse(line); } catch (e) { evt = { type: 'system', subtype: 'raw', raw: line.slice(0, 400) }; }
    claudeBroadcast(ses, evt);
    if (evt.type === 'assistant' && Array.isArray(evt.message && evt.message.content)) {
      const texts = evt.message.content.filter(c => c && c.type === 'text').map(c => c.text || '').join('');
      if (texts) ses.draft = texts;
    } else if (evt.type === 'result') {
      const txt = evt.result && typeof evt.result === 'string' ? evt.result : (ses.draft || '');
      if (txt) ses.messages.push({ role: 'assistant', text: txt, ts: new Date().toISOString(), final: true });
      ses.draft = '';
    }
  }
}
function createClaudeSession(project) {
  const id = 'cs-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  const cwd = project && fs.existsSync(project) ? path.normalize(project) : CLAUDE_DEFAULT_CWD;
  const ses = { id: id, project: cwd, title: path.basename(cwd), createdAt: new Date().toISOString(), messages: [], listeners: new Set(), proc: null, alive: false, draft: '', buffer: '' };
  claudeSessions.set(id, ses);
  try {
    ses.proc = claudeSpawn(cwd);
    ses.alive = true;
    ses.proc.stdout.on('data', d => claudeHandleData(ses, d));
    ses.proc.stderr.on('data', d => claudeHandleData(ses, d));
    ses.proc.on('close', code => { ses.alive = false; claudeBroadcast(ses, { type: 'system', subtype: 'exit', code: code }); });
    ses.proc.on('error', e => { ses.alive = false; claudeBroadcast(ses, { type: 'system', subtype: 'error', error: String((e && e.message) || e) }); });
  } catch (e) {
    claudeBroadcast(ses, { type: 'system', subtype: 'error', error: String((e && e.message) || e) });
  }
  return ses;
}
function readBody(req, cb) {
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 1e6) raw = raw.slice(0, 1e6); });
  req.on('end', () => cb(raw));
}
function claudeSessionIdFromUrl(url, suffix) {
  const prefix = '/claude/sessions/';
  if (!url.startsWith(prefix) || !url.endsWith(suffix)) return null;
  return decodeURIComponent(url.slice(prefix.length, url.length - suffix.length));
}
// 汇总 Claude 代理用量：今日明细 + 近 14 天汇总 + 当前供应商/模型
function collectUsage() {
  const empty = { ok: false, today: { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }, days: [], provider: '', models: [], usd2cny: USD2CNY };
  if (!fs.existsSync(CCSWITCH_DB)) return empty;
  try {
    const db = new DatabaseSync(CCSWITCH_DB, { readOnly: true });
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const t0 = todayStart.toISOString();
    const row = db.prepare("SELECT COUNT(*) AS requests, COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens, COALESCE(SUM(cache_read_tokens),0) AS cacheReadTokens, COALESCE(SUM(cache_creation_tokens),0) AS cacheWriteTokens, COALESCE(SUM(total_cost_usd),0) AS costUsd FROM proxy_request_logs WHERE app_type IN ('claude','claude-desktop') AND created_at >= ?").get(t0);
    const days = db.prepare("SELECT date, request_count AS requests, input_tokens AS inputTokens, output_tokens AS outputTokens, cache_read_tokens AS cacheReadTokens, cache_creation_tokens AS cacheWriteTokens, total_cost_usd AS costUsd FROM usage_daily_rollups WHERE app_type IN ('claude','claude-desktop') ORDER BY date DESC LIMIT 14").all();
    const prov = db.prepare("SELECT name FROM providers WHERE app_type IN ('claude','claude-desktop') AND is_current = 1 LIMIT 1").get();
    const models = db.prepare("SELECT model, COUNT(*) AS n FROM proxy_request_logs WHERE app_type IN ('claude','claude-desktop') AND created_at >= ? AND model != '' GROUP BY model ORDER BY n DESC LIMIT 5").all(t0);
    db.close();
    return {
      ok: true,
      today: {
        requests: Number(row.requests || 0),
        inputTokens: Number(row.inputTokens || 0),
        outputTokens: Number(row.outputTokens || 0),
        cacheReadTokens: Number(row.cacheReadTokens || 0),
        cacheWriteTokens: Number(row.cacheWriteTokens || 0),
        costUsd: Number(row.costUsd || 0)
      },
      days: (days || []).map(d => ({
        date: d.date,
        requests: Number(d.requests || 0),
        inputTokens: Number(d.inputTokens || 0),
        outputTokens: Number(d.outputTokens || 0),
        cacheReadTokens: Number(d.cacheReadTokens || 0),
        cacheWriteTokens: Number(d.cacheWriteTokens || 0),
        costUsd: Number(d.costUsd || 0)
      })),
      provider: prov ? String(prov.name || '') : '',
      models: (models || []).map(m => ({ model: String(m.model || ''), n: Number(m.n || 0) })),
      usd2cny: USD2CNY,
      db: CCSWITCH_DB
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), today: { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }, days: [], provider: '', models: [], usd2cny: USD2CNY };
  }
}

const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.gz': 'application/gzip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8'
};

fs.mkdirSync(DATA_BASE, { recursive: true });
const userFile = path.join(DATA_BASE, 'user-prompts.json');
if (!fs.existsSync(userFile)) {
  fs.writeFileSync(userFile, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), customs: [], favorites: [] }, null, 2), 'utf8');
}
const lockFile = path.join(DATA_BASE, 'server.lock');
const infoFile = path.join(DATA_BASE, 'server-info.json');

function log(msg) {
  const line = new Date().toISOString() + ' [pid=' + PID + ' v=' + VERSION + '] ' + msg + '\n';
  try { fs.appendFileSync(path.join(DATA_BASE, 'server.log'), line); } catch {}
  console.log(line.trim());
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}
function appOk() {
  return fs.existsSync(APP_HTML) && fs.statSync(APP_HTML).isFile();
}
function writeInfo(actualPort) {
  const info = {
    ok: appOk(),
    port: actualPort,
    url: 'http://127.0.0.1:' + actualPort + '/app',
    pid: PID,
    version: VERSION,
    assets: __dirname,
    startedAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString()
  };
  try {
    fs.writeFileSync(infoFile, JSON.stringify(info, null, 2), 'utf8');
    fs.writeFileSync(lockFile, JSON.stringify(info, null, 2), 'utf8');
  } catch {}
}
function reapStale() {
  try {
    if (!fs.existsSync(lockFile)) return;
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    if (!lock || !lock.pid || lock.pid === PID) return;
    if (!alive(lock.pid)) return;
    const assetsOk = lock.assets && fs.existsSync(path.join(lock.assets, 'AI提示词工作台.html'));
    const sameVersion = lock.version === VERSION;
    if (sameVersion && assetsOk) {
      log('another healthy instance pid=' + lock.pid + ' port=' + lock.port + ' already running, exit');
      process.exit(0);
    }
    log('stale instance pid=' + lock.pid + ' version=' + lock.version + ' assetsOk=' + assetsOk + ' -> terminating');
    try { process.kill(lock.pid, 'SIGTERM'); } catch (e) {}
    setTimeout(() => {
      try { if (alive(lock.pid)) process.kill(lock.pid, 'SIGKILL'); } catch (e) {}
    }, 1200);
  } catch (e) { /* 锁损坏则忽略 */ }
}

/**
 * 将请求中的相对路径安全地解析到 base 目录内。
 * @param {string} base 绝对基准目录（已 normalize）
 * @param {string} rel   未经解码的 URL 相对路径（如 "user-prompts.json" 或 "../xxx"）
 * @returns {string|null} 若路径合法（段边界内）返回规范化绝对路径；解码失败/越界返回 null
 */
function safePath(base, rel) {
  try { rel = decodeURIComponent(rel); } catch (e) { return null; }
  const full = path.normalize(path.join(base, rel));
  if (full === base || full.startsWith(base + path.sep)) return full;
  return null;
}
/**
 * CORS 来源白名单：仅放行本机页面。
 * @param {string|undefined} origin 请求头 Origin（浏览器提供；node/curl 无）
 * @returns {boolean} 是否允许访问
 */
function corsAllowed(origin) {
  if (!origin) return true; /* 同源请求或非浏览器（node/curl），无需校验 */
  if (origin === 'null') return true; /* file:// 页面 */
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  } catch (e) { return false; }
}
/**
 * 已知数据文件的轻量结构校验，防止脏数据污染共享状态。
 * @param {string} fileName 数据文件名（如 workbench-state.json）
 * @param {any} obj JSON.parse 后的载荷
 * @returns {boolean} 结构合法返回 true
 */
function validateDataPayload(fileName, obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (fileName === 'workbench-state.json') {
    return Array.isArray(obj.customs) && Array.isArray(obj.favorites) &&
      obj.community && typeof obj.community === 'object' &&
      Array.isArray(obj.community.prompts) && Array.isArray(obj.community.favorites);
  }
  if (fileName === 'user-prompts.json') {
    return Array.isArray(obj.customs) && Array.isArray(obj.favorites);
  }
  return true; // 其它数据文件仅要求是合法 JSON 对象
}
/**
 * 原子写入：先写临时文件再 rename，避免进程中断导致半写文件。
 * @param {string} full    目标文件绝对路径
 * @param {string} content 写入内容
 */
function atomicWrite(full, content) {
  const tmp = full + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, full);
}

const server = http.createServer((req, res) => {
  const origin = req.headers.origin;
  if (origin && !corsAllowed(origin)) { res.writeHead(403); res.end(); return; }
  if (corsAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method === 'GET' && req.url === '/permissions') {
    let mode = 'ask';
    try {
      if (fs.existsSync(PERM_FILE)) {
        const cfg = JSON.parse(fs.readFileSync(PERM_FILE, 'utf8'));
        const dm = cfg && cfg.permissions && cfg.permissions.defaultMode;
        if (dm === 'acceptEdits') mode = 'auto';
        else if (dm === 'bypassPermissions') mode = 'full';
      }
    } catch (e) { /* 读取失败按默认处理 */ }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, mode: mode, file: PERM_FILE }));
    return;
  }
  if (req.method === 'POST' && req.url === '/permissions') {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 65536) raw = raw.slice(0, 65536); });
    req.on('end', () => {
      let mode = null;
      try { mode = JSON.parse(raw).mode; } catch (e) { mode = null; }
      if (!PERM_MODES[mode]) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, message: 'invalid mode' }));
        return;
      }
      try {
        let cfg = {};
        if (fs.existsSync(PERM_FILE)) {
          try { cfg = JSON.parse(fs.readFileSync(PERM_FILE, 'utf8')) || {}; } catch (e) { cfg = {}; }
        }
        if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) cfg = {};
        if (!cfg.permissions || typeof cfg.permissions !== 'object' || Array.isArray(cfg.permissions)) cfg.permissions = {};
        cfg.permissions.defaultMode = PERM_MODES[mode];
        atomicWrite(PERM_FILE, JSON.stringify(cfg, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, mode: mode }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, message: String((e && e.message) || e) }));
      }
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/usage') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(collectUsage()));
    return;
  }
  if (req.url === '/claude' || req.url === '/claude/') {
    if (!fs.existsSync(CLAUDE_HTML)) { res.writeHead(404); res.end('claude client html missing'); return; }
    serveFile(res, CLAUDE_HTML);
    return;
  }
  if (req.method === 'GET' && req.url === '/claude/sessions') {
    const list = Array.from(claudeSessions.values()).map(s => ({
      id: s.id, project: s.project, title: s.title, createdAt: s.createdAt,
      messages: s.messages.length, alive: s.alive
    }));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, sessions: list }));
    return;
  }
  if (req.method === 'POST' && req.url === '/claude/sessions') {
    readBody(req, raw => {
      let project = '';
      try { project = JSON.parse(raw).project || ''; } catch (e) { project = ''; }
      const ses = createClaudeSession(project);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, id: ses.id, project: ses.project, title: ses.title, alive: ses.alive }));
    });
    return;
  }
  const msgId = claudeSessionIdFromUrl(req.url, '/messages');
  if (req.method === 'POST' && msgId) {
    const ses = claudeSessions.get(msgId);
    if (!ses) { res.writeHead(404); res.end(JSON.stringify({ ok: false, message: 'session not found' })); return; }
    readBody(req, raw => {
      let text = '';
      try { text = JSON.parse(raw).text || ''; } catch (e) { text = ''; }
      text = String(text).trim();
      if (!text) { res.writeHead(400); res.end(JSON.stringify({ ok: false, message: 'empty text' })); return; }
      if (!ses.alive || !ses.proc || !ses.proc.stdin.writable) { res.writeHead(409); res.end(JSON.stringify({ ok: false, message: 'session not running' })); return; }
      ses.messages.push({ role: 'user', text: text, ts: new Date().toISOString() });
      claudeBroadcast(ses, { type: 'user', text: text, ts: new Date().toISOString() });
      ses.proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: text }] } }) + '\n');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  const evtId = claudeSessionIdFromUrl(req.url, '/events');
  if (req.method === 'GET' && evtId) {
    const ses = claudeSessions.get(evtId);
    if (!ses) { res.writeHead(404); res.end(JSON.stringify({ ok: false, message: 'session not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write('retry: 3000\n\n');
    ses.messages.forEach(m => res.write('data: ' + JSON.stringify({ type: 'message', message: m }) + '\n\n'));
    res.write('data: ' + JSON.stringify({ type: 'system', subtype: 'connected', alive: ses.alive }) + '\n\n');
    ses.listeners.add(res);
    req.on('close', () => ses.listeners.delete(res));
    return;
  }
  const stopId = claudeSessionIdFromUrl(req.url, '/stop');
  if (req.method === 'POST' && stopId) {
    const ses = claudeSessions.get(stopId);
    if (ses && ses.proc) { try { ses.proc.kill('SIGTERM'); } catch (e) {} }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === 'POST' && req.url.startsWith('/data/')) {
    const full = safePath(DATA_BASE, req.url.slice('/data/'.length));
    if (!full) { res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ code: 403 })); return; }
    let raw = '';
    let tooBig = false;
    req.on('data', c => {
      raw += c;
      if (raw.length > 40 * 1024 * 1024) tooBig = true;
    });
    req.on('end', () => {
      if (tooBig) { res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ code: 413 })); return; }
      try {
        const parsed = JSON.parse(raw);
        if (!validateDataPayload(path.basename(full), parsed)) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, message: 'invalid payload schema' }));
          return;
        }
        atomicWrite(full, raw);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, message: String((e && e.message) || e) }));
      }
    });
    return;
  }
  if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
  if (req.url === '/health') {
    const actualPort = server.address() ? server.address().port : PORT;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: appOk(), port: actualPort, pid: PID, version: VERSION, assets: __dirname, app: appOk() ? 'ok' : 'missing' }));
    return;
  }
  let appPath = req.url.split('?')[0];
  try { appPath = decodeURIComponent(appPath); } catch (e) { /* 保持原样 */ }
  if (appPath === '/app' || appPath === '/app/' || appPath.startsWith('/app')) {
    if (!appOk()) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ code: 404, message: 'workbench html missing: ' + APP_HTML }));
      return;
    }
    serveFile(res, APP_HTML);
    return;
  }
  if (req.url.startsWith('/libs/')) {
    let rel = null;
    try { rel = decodeURIComponent(req.url.slice('/libs/'.length)); } catch (e) { rel = null; }
    if (rel && LIB_ALLOW.has(path.basename(rel))) {
      serveFile(res, path.join(LIB_BASE, path.basename(rel)));
      return;
    }
    res.writeHead(403); res.end(); return;
  }
  if (req.url === '/prompts.csv') { serveFile(res, path.join(__dirname, 'prompts.csv')); return; }
  if (req.url === '/sw.js') { serveFile(res, path.join(__dirname, 'sw.js')); return; }
  if (req.url === '/manifest.webmanifest') { serveFile(res, path.join(__dirname, 'manifest.webmanifest')); return; }
  if (req.url.startsWith('/data/')) {
    const full = safePath(DATA_BASE, req.url.slice('/data/'.length));
    if (!full) { res.writeHead(403); res.end(); return; }
    serveFile(res, full);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ code: 404 }));
});

/**
 * 静态文件响应：按扩展名给 MIME，缺失/非文件返回 404。
 * @param {import('node:http').ServerResponse} res
 * @param {string} full 文件绝对路径
 */
function serveFile(res, full) {
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ code: 404 })); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(full).pipe(res);
  });
}

let retriedSame = false;
function tryListen(port, tries) {
  server.once('error', err => {
    if (err.code === 'EADDRINUSE') {
      if (!retriedSame && tries > 0) {
        retriedSame = true;
        reapStale();
        setTimeout(() => { server.close(); tryListen(port, tries); }, 300);
        return;
      }
      if (tries > 0) {
        log('port ' + port + ' busy, fallback to ' + (port + 1));
        server.close();
        tryListen(port + 1, tries - 1);
      } else {
        console.error('server error: all ports busy');
        process.exit(1);
      }
    } else {
      console.error('server error: ' + err.message);
      process.exit(1);
    }
  });
  server.listen(port, '127.0.0.1', () => {
    const actualPort = server.address().port;
    writeInfo(actualPort);
    log('server started on 127.0.0.1:' + actualPort + ' url=http://127.0.0.1:' + actualPort + '/app');
  });
}

reapStale();
tryListen(PORT, 20);
setInterval(() => {
  try {
    const info = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
    info.lastHeartbeat = new Date().toISOString();
    fs.writeFileSync(infoFile, JSON.stringify(info, null, 2), 'utf8');
  } catch {}
}, 30000);
