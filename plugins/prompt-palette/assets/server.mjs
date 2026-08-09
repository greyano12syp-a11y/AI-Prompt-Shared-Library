#!/usr/bin/env node
// AI 提示词共享库本地服务：HTTP 打开工作台与提示词深链。
// 特性：真实端口健康检查、PID/版本标识、单实例锁、旧实例回收、心跳。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_HTML = path.join(__dirname, 'AI提示词工作台.html');
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
