#!/usr/bin/env node
/**
 * server.mjs 集成测试
 * 用独立端口 + 临时数据目录拉起真实服务，逐项验证：
 *  - CORS 收紧（任意外部站点被拒，file:// 与本机放行）
 *  - /data/ 路径穿越（兄弟目录前缀绕过、URL 编码、畸形编码、深层）
 *  - /libs/ 白名单
 *  - POST schema 校验
 *  - 原子写入 / 数据落地
 *
 * 运行：node test/server.test.mjs
 * 退出码：0 全部通过；1 有失败；2 无法启动服务。
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ASSETS = path.resolve('assets');
const SERVER = path.join(ASSETS, 'server.mjs');
const PORT = 13190; // 固定独立端口，避开默认 1190
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-test-'));

let child = null;
let pass = 0;
let fail = 0;

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + name + (extra ? '  (' + extra + ')' : '')); }
}

function request(port, opts) {
  return new Promise((resolve, reject) => {
    const req = http.request(Object.assign({ host: '127.0.0.1', port }, opts), res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function waitUp(port, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try { const r = await request(port, { path: '/health', method: 'GET' }); if (r.status === 200) return true; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

async function main() {
  console.log('启动 server.mjs（port=' + PORT + '，临时数据目录=' + DATA + '）…');
  child = spawn(process.execPath, [SERVER, '--port', String(PORT), '--data', DATA], { stdio: 'inherit' });
  if (!(await waitUp(PORT))) { console.error('\x1b[31m无法启动服务\x1b[0m'); child.kill(); process.exit(2); }
  console.log('服务已就绪。\n');

  /* ---------- CORS ---------- */
  console.log('【CORS】');
  let r = await request(PORT, { path: '/health', method: 'GET', headers: { origin: 'https://evil.example.com' } });
  ok('外部站点 Origin 被拒 403', r.status === 403, 'status=' + r.status);
  r = await request(PORT, { path: '/health', method: 'GET', headers: { origin: 'http://127.0.0.1:8000' } });
  ok('本机 127.0.0.1 来源放行', r.status === 200, 'status=' + r.status);
  ok('  回写 ACAO 为本机', r.headers['access-control-allow-origin'] === 'http://127.0.0.1:8000', r.headers['access-control-allow-origin']);
  r = await request(PORT, { path: '/health', method: 'GET', headers: { origin: 'null' } });
  ok('file://（Origin:null）放行', r.status === 200, 'status=' + r.status);
  r = await request(PORT, { path: '/health', method: 'GET' });
  ok('无 Origin（node/curl）放行', r.status === 200, 'status=' + r.status);
  r = await request(PORT, { path: '/data/user-prompts.json', method: 'GET', headers: { origin: 'https://evil.example.com' } });
  ok('外部站点读 /data 被拒 403', r.status === 403, 'status=' + r.status);
  // 预检
  r = await request(PORT, { path: '/data/user-prompts.json', method: 'OPTIONS', headers: { origin: 'https://evil.example.com' } });
  ok('外部站点 OPTIONS 预检被拒 403', r.status === 403, 'status=' + r.status);
  r = await request(PORT, { path: '/data/user-prompts.json', method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:8000' } });
  ok('本机 OPTIONS 预检 204', r.status === 204, 'status=' + r.status);

  /* ---------- /data/ 路径穿越 ---------- */
  console.log('\n【/data/ 路径穿越】');
  const evilDir = DATA + '-evil';
  fs.mkdirSync(evilDir, { recursive: true });
  fs.writeFileSync(path.join(evilDir, 'evil.json'), '{"owned":true}', 'utf8');
  // 兄弟目录（旧代码漏洞核心）—— URL 编码 ../ 使其更像真实攻击
  r = await request(PORT, { path: '/data/' + encodeURIComponent('../' + path.basename(evilDir)) + '/evil.json', method: 'GET' });
  ok('兄弟目录穿越（../<名>）被拒 403', r.status === 403, 'status=' + r.status);
  // 深层穿越
  r = await request(PORT, { path: '/data/' + encodeURIComponent('../../etc/passwd'), method: 'GET' });
  ok('深层穿越被拒 403', r.status === 403, 'status=' + r.status);
  // URL 编码的 ../
  r = await request(PORT, { path: '/data/%2e%2e%2f%2e%2e%2fserver.mjs', method: 'GET' });
  ok('编码穿越 %2e%2e 被拒 403', r.status === 403, 'status=' + r.status);
  // 畸形编码（旧代码会 URIError 崩溃）
  r = await request(PORT, { path: '/data/%E0%A4%A', method: 'GET' });
  ok('畸形编码被拒 403 且服务存活', r.status === 403, 'status=' + r.status);
  const alive = await request(PORT, { path: '/health', method: 'GET' });
  ok('  服务在畸形编码后仍存活', alive.status === 200, 'status=' + alive.status);
  // 正常子路径仍可读
  r = await request(PORT, { path: '/data/user-prompts.json', method: 'GET' });
  ok('正常文件仍可读 200', r.status === 200 && r.body.includes('"customs"'), 'status=' + r.status);

  /* ---------- /libs/ 白名单 ---------- */
  console.log('\n【/libs/ 白名单】');
  r = await request(PORT, { path: '/libs/mammoth.browser.min.js', method: 'GET' });
  ok('白名单内库可读 200', r.status === 200, 'status=' + r.status);
  r = await request(PORT, { path: '/libs/../server.mjs', method: 'GET' });
  ok('/libs/.. 越界被拒 403', r.status === 403, 'status=' + r.status);
  r = await request(PORT, { path: '/libs/not-exist.js', method: 'GET' });
  ok('白名单外文件被拒 403', r.status === 403, 'status=' + r.status);

  /* ---------- POST schema 校验 ---------- */
  console.log('\n【POST /data/ schema 校验】');
  const goodState = JSON.stringify({ version: 1, updatedAt: '2026-08-08T00:00:00.000Z', customs: [], favorites: [], community: { prompts: [], favorites: [] } });
  r = await request(PORT, { path: '/data/workbench-state.json', method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: goodState });
  ok('合法 workbench-state 写入 200', r.status === 200, 'status=' + r.status + ' body=' + r.body);
  r = await request(PORT, { path: '/data/workbench-state.json', method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ customs: 'not-array' }) });
  ok('非法 schema 被拒 400', r.status === 400, 'status=' + r.status);
  r = await request(PORT, { path: '/data/workbench-state.json', method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'not json at all' });
  ok('非法 JSON 被拒 400', r.status === 400, 'status=' + r.status);
  // 单条上传（其它数据文件仅要求合法 JSON 对象）
  r = await request(PORT, { path: '/data/any-other.json', method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ hello: 'world' }) });
  ok('其它文件合法对象写入 200', r.status === 200, 'status=' + r.status);
  r = await request(PORT, { path: '/data/../../evil.json', method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ x: 1 }) });
  ok('POST 穿越写入被拒 403', r.status === 403, 'status=' + r.status);
  // 写入落地 + 原子性（不应残留 .tmp 文件）
  const written = JSON.parse(fs.readFileSync(path.join(DATA, 'workbench-state.json'), 'utf8'));
  ok('写入已落地到数据目录', written.customs && Array.isArray(written.customs), '');
  const leftovers = fs.readdirSync(DATA).filter(f => f.includes('.tmp'));
  ok('无残留临时文件', leftovers.length === 0, leftovers.join(','));

  console.log('\n结果：\x1b[32m' + pass + ' 通过\x1b[0m / \x1b[31m' + fail + ' 失败\x1b[0m');
  child.kill();
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); child && child.kill(); process.exit(1); });
