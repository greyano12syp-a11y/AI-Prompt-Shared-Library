#!/usr/bin/env node
// Prompt Palette 本地检索脚本：让 agent 在干活前自动从提示词库匹配最相关的任务提示词。
// 用法：
//   node search_prompt.mjs "SQL 优化"                 # 默认输出前 5 条
//   node search_prompt.mjs "周报" --category write    # 限定分类
//   node search_prompt.mjs "数据分析" --full           # 输出完整正文（供直接套用）
//   node search_prompt.mjs "配色" --json               # JSON 输出
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let WB_BASE = 'http://127.0.0.1:1189/app';
function wbLink(x) {
  const key = x.id || x.t;
  return WB_BASE + '?prompt=' + encodeURIComponent(key);
}
const CATS = {
  meta: '通用', dev: '编程', write: '写作', art: '美术/设计', fin: '金融/投资', data: '数据分析', my: '我的'
};

function norm(s) {
  return String(s || '').replace(/\u3000/g, ' ').replace(/[\uff01-\uff5e]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)).toLowerCase();
}
function levMax(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const m = a.length, n = b.length;
  if (!m) return n > max ? max + 1 : n;
  if (!n) return m > max ? max + 1 : m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    let rowMin = cur[0];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[n];
}
function fuzzyContains(hay, term, tol) {
  if (tol <= 0) return hay.includes(term);
  if (hay.length < term.length - tol) return false;
  for (let i = 0; i + term.length <= hay.length; i++) {
    if (levMax(hay.slice(i, i + term.length), term, tol) <= tol) return true;
  }
  return false;
}
function isSubseq(term, hay) {
  if (!term || term.length < 2 || term.length > hay.length) return false;
  let i = 0;
  for (let j = 0; j < hay.length && i < term.length; j++) if (hay.charCodeAt(j) === term.charCodeAt(i)) i++;
  return i === term.length;
}
function tol(term) {
  return term.length <= 2 ? 0 : Math.max(1, Math.floor(term.length / 4));
}
function scoreItem(item, terms) {
  const t = norm(item.t);
  const tags = norm((item.tags || []).join(' '));
  const p = norm(String(item.p || '').slice(0, 400));
  let total = 0;
  for (const term of terms) {
    let best = 0;
    if (t.includes(term)) best = 3;
    else if (tags.includes(term)) best = 2.5;
    else if (p.includes(term)) best = 2;
    if (!best && fuzzyContains(t.slice(0, 120), term, tol(term))) best = 1.8;
    if (!best && (isSubseq(term, t.slice(0, 100)) || isSubseq(term, tags.slice(0, 80)))) best = 1.4;
    if (!best && fuzzyContains(p.slice(0, 200), term, tol(term))) best = 1;
    if (!best) return 0;
    total += best;
  }
  return total;
}
function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function dataDir() {
  if (process.env.PP_DATA_DIR) return process.env.PP_DATA_DIR;
  if (process.platform === 'win32' || fs.existsSync(path.join(os.homedir(), 'Documents'))) {
    return path.join(os.homedir(), 'Documents', 'Codex', 'prompt-palette-data');
  }
  return path.join(os.homedir(), '.prompt-palette');
}
async function httpOk(url, ms) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms || 700);
    const r = await fetch(url, { signal: ctl.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}
function portOpen(port, ms) {
  return new Promise(resolve => {
    const s = net.connect({ port: port, host: '127.0.0.1' });
    const done = ok => { try { s.destroy(); } catch {} resolve(ok); };
    s.setTimeout(ms || 600, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}
async function ensureServices() {
  const deepLxDir = process.env.DEEPLX_DIR || path.join(os.homedir(), 'DeepLX');
  const exeName = process.platform === 'win32' ? 'deeplx.exe' : 'deeplx';
  const deeplx = [process.env.DEEPLX_BIN, path.join(deepLxDir, exeName), '/usr/local/bin/deeplx', '/opt/homebrew/bin/deeplx'].find(p => p && fs.existsSync(p));
  const nodeBin = process.env.PP_NODE_BIN || process.execPath;
  const proxy = [process.env.PP_TRANSLATE_PROXY, path.join(deepLxDir, 'baidu-translate-proxy.mjs'), path.join(__dirname, 'baidu-translate-proxy.mjs')].find(p => p && fs.existsSync(p));
  if (!(await portOpen(1188)) && deeplx) {
    try { spawn(deeplx, [], { cwd: path.dirname(deeplx), detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch {}
  }
  if (!(await httpOk('http://127.0.0.1:1189/health', 500)) && proxy) {
    try { spawn(nodeBin, [proxy], { cwd: path.dirname(proxy), detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch {}
  }
  for (let i = 0; i < 12; i++) {
    if (await httpOk('http://127.0.0.1:1189/health', 500)) break;
    await new Promise(r => setTimeout(r, 500));
  }
}
async function getAppBase() {
  const infoPath = path.join(dataDir(), 'server-info.json');
  const info = loadJson(infoPath, null);
  if (info && info.url) {
    const base = info.url.replace(/\/app.*$/, '');
    if (await httpOk(base + '/health', 600)) return base + '/app';
  }
  for (const port of [1190, 1191, 1192, 1193, 1189]) {
    if (await httpOk('http://127.0.0.1:' + port + '/health', 600)) return 'http://127.0.0.1:' + port + '/app';
  }
  const serverFile = path.join(__dirname, 'server.mjs');
  if (fs.existsSync(serverFile)) {
    try {
      const child = spawn(process.execPath, [serverFile], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
    } catch {}
    for (let i = 0; i < 25; i++) {
      await new Promise(r => setTimeout(r, 400));
      const info2 = loadJson(infoPath, null);
      if (info2 && info2.url && await httpOk(info2.url.replace(/\/app.*$/, '') + '/health', 500)) return info2.url.replace(/\/app.*$/, '') + '/app';
    }
  }
  return 'http://127.0.0.1:1189/app';
}
function estimateCost(text, cfg) {
  const cjk = (String(text).match(/[\u4e00-\u9fff]/g) || []).length;
  const other = String(text).length - cjk;
  const tokens = Math.ceil(cjk * 1.0 + other * 0.3);
  const price = Number((cfg && cfg.pricePerMTokCny) || 2);
  return { tokens: tokens, cost: tokens / 1000000 * price, price: price };
}

const args = process.argv.slice(2);
function argVal(name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}
const queryParts = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--limit' || a === '--category') { i++; continue; }
  if (a.startsWith('--')) continue;
  queryParts.push(a);
}
const query = queryParts.join(' ').trim();
const category = argVal('--category');
const full = args.includes('--full');
const asJson = args.includes('--json');
const estimate = args.includes('--estimate');
const limit = Math.min(10, Math.max(1, parseInt(argVal('--limit'), 10) || 5));
const DATA_DIR = dataDir();
const cfg = loadJson(path.join(DATA_DIR, 'agent-match-config.json'), {});
await ensureServices();
WB_BASE = await getAppBase();

if (!query) {
  console.log('用法：node search_prompt.mjs "关键词" [--category dev|write|art|fin|data|meta] [--full] [--json] [--limit N]');
  process.exit(0);
}

const items = [];
const builtin = loadJson(path.join(__dirname, 'prompts.json'), []);
if (Array.isArray(builtin)) builtin.forEach(x => items.push(Object.assign({ source: '内置' }, x)));
const userFile = path.join(DATA_DIR, 'user-prompts.json');
const userData = loadJson(userFile, { customs: [] });
if (Array.isArray(userData.customs)) userData.customs.forEach(x => items.push(Object.assign({ source: '我的' }, x)));

const terms = norm(query).split(/\s+/).filter(Boolean);
let list = items
  .filter(x => !category || x.c === category || (category === 'write' && (x.c === 'write' || x.c === 'meta')))
  .map(x => ({ x, s: scoreItem(x, terms) }))
  .filter(r => r.s > 0)
  .sort((a, b) => b.s - a.s || String(a.x.t).length - String(b.x.t).length)
  .slice(0, limit)
  .map(r => r.x);

if (asJson) {
  console.log(JSON.stringify(list.map(x => ({
    id: x.id, title: x.t, category: CATS[x.c] || x.c, tags: x.tags || [], source: x.source,
    content: full ? x.p : (x.p || '').slice(0, 120)
  })), null, 2));
} else if (estimate) {
  const titles = list.map(x => x.t + ' ' + (x.tags || []).join(' ')).join('\n');
  const titleEst = estimateCost(titles, cfg);
  const best = list[0];
  if (best) {
    const fullEst = estimateCost(best.p, cfg);
    const overhead = 800;
    const totalTokens = titleEst.tokens + fullEst.tokens + overhead;
    const totalCost = totalTokens / 1000000 * (cfg.pricePerMTokCny || 2);
    console.log('候选 ' + list.length + ' 条（仅标题，约 ' + titleEst.tokens + ' token）');
    list.forEach((x, i) => console.log((i + 1) + '. [' + x.t + '（' + (CATS[x.c] || x.c) + '）](' + wbLink(x) + ')'));
    console.log('建议套用：' + best.t);
    console.log('全文约 ' + String(best.p).length + ' 字 ≈ ' + fullEst.tokens + ' token');
    console.log('合计（含对话上下文约 ' + overhead + ' token）：约 ' + totalTokens + ' token ≈ ¥' + totalCost.toFixed(4) + '（按 ' + (cfg.pricePerMTokCny || 2) + ' 元/百万 token 估算）');
  } else {
    console.log('未找到匹配的提示词，预计几乎不消耗 token。');
  }
} else if (list.length === 0) {
  console.log('未找到匹配的提示词。可用“需求转提示词”模板（meta-1）把任务目标改写成结构化提示词。');
} else {
  list.forEach((x, i) => {
    console.log((i + 1) + '. [' + x.t + '（' + (CATS[x.c] || x.c) + ' / ' + x.source + '）](' + wbLink(x) + ')' + (x.tags && x.tags.length ? ' — ' + x.tags.join(', ') : ''));
    if (full) {
      console.log('---');
      console.log(x.p);
      console.log('---');
    } else {
      console.log('   ' + String(x.p || '').replace(/\s+/g, ' ').slice(0, 100));
    }
  });
}
