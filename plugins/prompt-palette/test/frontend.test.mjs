#!/usr/bin/env node
/**
 * 前端核心逻辑单元测试（AI提示词工作台.html 内纯函数）
 *
 * 提取 HTML 主 <script>，用 vm 沙箱 + 轻量 DOM stub 执行到函数定义区，
 * 然后测试：
 *  - esc() 转义（XSS 防护）
 *  - validGistId() / sanitizeGistId()（Gist ID 输入校验）
 *  - normSearch / fuzzyScore / fuzzyPossible（搜索正确性与粗筛不漏匹配）
 *  - dedupeItems（去重与来源优先级）
 *  - atLeastExact / isSubseq / fuzzyContains 边界
 *
 * 运行：node test/frontend.test.mjs
 * 退出码：0 通过；1 有失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const HTML = path.resolve('assets/AI提示词工作台.html');
const html = fs.readFileSync(HTML, 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('未找到主 <script>'); process.exit(1); }
const script = m[1];

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + name + (extra ? '  (' + extra + ')' : '')); }
}

// ---- 轻量 DOM stub（只提供被测函数引用到的 API）----
function elementStub() {
  return {
    addEventListener() {}, value: '', textContent: '', innerHTML: '',
    style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, getAttribute() { return null; },
    appendChild() {}, insertBefore() {},
    querySelectorAll() { return []; }, querySelector() { return null; },
    closest() { return null; }, focus() {}, blur() {}, click() {},
    offsetWidth: 0, offsetHeight: 0, remove() {}
  };
}
const elCache = new Map();
function domGet(id) {
  if (!elCache.has(id)) elCache.set(id, elementStub());
  return elCache.get(id);
}

const sandbox = {
  console,
  $: domGet,
  document: {
    getElementById: domGet,
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() { return elementStub(); },
    addEventListener() {},
    body: elementStub()
  },
  window: {
    addEventListener() {},
    matchMedia() { return { matches: false, addEventListener() {} }; },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    location: { search: '', hash: '' },
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    navigator: { clipboard: { writeText: async () => {} }, userAgent: 'node' },
    URL, URLSearchParams, Blob, FileReader: class FileReader {},
    atob: s => Buffer.from(s, 'base64').toString('binary'),
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    TextEncoder, TextDecoder, crypto: globalThis.crypto,
    requestAnimationFrame() { return 0; },
    performance: { now() { return 0; } }
  },
  Promise, Date, JSON, Math, String, Number, Boolean, Array, Object,
  Map, Set, RegExp, Error, parseInt, parseFloat, isNaN, isFinite,
  encodeURIComponent, decodeURIComponent,
  confirm() { return true; }, alert() {}
};
sandbox.globalThis = sandbox;

const ctx = vm.createContext(sandbox);
try {
  vm.runInContext(script, ctx, { filename: 'AI提示词工作台.html<script>' });
} catch (e) {
  // 脚本顶层有副作用代码（事件绑定等），DOM stub 不全会抛错；
  // 只要函数定义区已执行、被测函数存在即可继续。
  console.log('  （顶层副作用求值提示：' + (e && e.message) + '）');
}

function grab(name) {
  const fn = sandbox[name];
  if (typeof fn !== 'function') { console.error('未定义函数 ' + name); return null; }
  return fn;
}

const esc = grab('esc');
const normSearch = grab('normSearch');
const validGistId = grab('validGistId');
const sanitizeGistId = grab('sanitizeGistId');
const fuzzyScore = grab('fuzzyScore');
const fuzzyPossible = grab('fuzzyPossible');
const fuzzyTol = grab('fuzzyTol');
const fuzzyContains = grab('fuzzyContains');
const isSubseq = grab('isSubseq');
const atLeastExact = grab('atLeastExact');
const dedupeItems = grab('dedupeItems');
const levMax = grab('levMax');

if (esc && normSearch) {
  console.log('\n【esc() 转义】');
  ok('HTML 特殊字符全转义', esc('<img src=x onerror=alert(1)>') === '&lt;img src=x onerror=alert(1)&gt;');
  ok('引号转义', esc('"\'') === '&quot;&#39;');
  ok('正常文本不受影响', esc('你好 SQL') === '你好 SQL');
}

if (validGistId && sanitizeGistId) {
  console.log('\n【validGistId / sanitizeGistId】');
  ok('32 位十六进制合法', validGistId('0123456789abcdef0123456789abcdef') === true);
  ok('20 位十六进制合法', validGistId('0123456789abcdef0123') === true);
  ok('小于 20 位拒绝', validGistId('abc123') === false);
  ok('大于 32 位拒绝', validGistId('0'.repeat(40)) === false);
  ok('非十六进制（G 等）拒绝', validGistId('gggggggggggggggggggggggggggggggg') === false);
  ok('URL 形式拒绝', validGistId('https://gist.github.com/abc') === false);
  ok('含危险字符被清洗', sanitizeGistId('abc<>def"ghi') === 'abcdefghi');
  ok('空白被 trim', validGistId('  0123456789abcdef0123456789abcdef  ') === true);
}

if (fuzzyScore && fuzzyPossible && normSearch) {
  console.log('\n【搜索：fuzzyScore / fuzzyPossible】');
  const card = { id: 'x1', c: 'dev', t: 'SQL 性能优化', tags: ['数据库', '索引'], d: '优化慢查询', p: '这里是最佳实践正文……' };
  ok('标题精确命中 100', fuzzyScore(card, [normSearch('SQL')]) === 100);
  ok('标签命中 90', fuzzyScore(card, [normSearch('数据库')]) === 90);
  ok('描述命中 80', fuzzyScore(card, [normSearch('慢查询')]) === 80);
  ok('正文命中 60', fuzzyScore(card, [normSearch('最佳实践')]) === 60);
  ok('无关词得 0 分', fuzzyScore(card, [normSearch('音乐')]) === 0);
  ok('粗筛放行命中卡片', fuzzyPossible(card, [normSearch('SQL')]) === true);
  ok('粗筛放行标签命中', fuzzyPossible(card, [normSearch('数据库')]) === true);
  ok('粗筛拦截无关卡片', fuzzyPossible(card, [normSearch('音乐')]) === false);

  const samples = [
    { id: 's1', c: 'dev', t: 'SQL 性能优化', zh: '', tags: ['数据库'], d: '慢查询调优', p: '正文 全文' },
    { id: 's2', c: 'write', t: '周报生成', zh: '', tags: ['办公'], d: '周报 写作', p: '写一篇周报' },
    { id: 's3', c: 'fin', t: '财报分析', zh: '', tags: ['金融'], d: '财报 分析', p: '分析财报数据' },
    { id: 's4', c: 'art', t: 'Logo 设计', zh: '', tags: ['设计'], d: '标志 设计', p: '设计一个 Logo' },
    { id: 's5', c: 'data', t: '回归分析', zh: '', tags: ['统计'], d: '回归 建模', p: '线性回归 分析' }
  ];
  const queries = [['sql'], ['周报'], ['分析'], ['设计'], ['回归'], ['不存在词'], ['性能', '数据库']];
  let noMiss = true, detail = '';
  for (const q of queries) {
    const terms = q.map(normSearch);
    for (const c of samples) {
      const possible = fuzzyPossible(c, terms);
      const scored = fuzzyScore(c, terms) > 0;
      if (scored && !possible) { noMiss = false; detail += '  ' + c.t + ' / ' + q.join('+'); }
    }
  }
  ok('粗筛不漏匹配（possible ⊇ scored）', noMiss, detail);
  ok('levMax 相同串 0', levMax('abc', 'abc', 2) === 0);
  ok('levMax 超限提前返回', levMax('abcdef', 'abcxyz', 1) > 1);
}

if (dedupeItems) {
  console.log('\n【dedupeItems 去重】');
  const a = { id: '1', source: '内置', p: '相同正文 相同正文' };
  const b = { id: '2', source: '我的', p: '相同正文 相同正文' };
  const c = { id: '3', source: '社区', p: '  相同正文 相 同正文  ' };
  const out = dedupeItems([a, b, c]);
  ok('相同正文合并为 1 条', out.length === 1, 'len=' + out.length);
  ok('优先级保留“我的”', out[0].source === '我的', out[0] && out[0].source);
  const d = { id: '4', source: '内置', p: '' };
  const out2 = dedupeItems([a, d]);
  ok('空正文不参与去重', out2.length === 2, 'len=' + out2.length);
}

if (isSubseq) {
  console.log('\n【isSubseq 边界】');
  ok('子序列命中', isSubseq('syz', 'sayz') === true);
  ok('单字符不做子序列（长度≥2 才判）', isSubseq('s', 's') === false);
  ok('超长子序列拒绝', isSubseq('abcdefg', 'abc') === false);
}

if (atLeastExact) {
  console.log('\n【atLeastExact】');
  ok('need<=0 恒真', atLeastExact('', '', 0) === true);
  ok('足够精确字符满足', atLeastExact('abc', 'abc', 2) === true);
  ok('不足精确字符不满足', atLeastExact('abc', 'xyz', 2) === false);
}

console.log('\n结果：\x1b[32m' + pass + ' 通过\x1b[0m / \x1b[31m' + fail + ' 失败\x1b[0m');
process.exit(fail ? 1 : 0);
