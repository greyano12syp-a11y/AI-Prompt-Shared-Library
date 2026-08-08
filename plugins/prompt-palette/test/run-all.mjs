#!/usr/bin/env node
/**
 * 一键跑全部测试（server 集成 + 前端核心逻辑）。
 * 用法：node test/run-all.mjs
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const suites = ['server.test.mjs', 'frontend.test.mjs'];
let failed = 0;

for (const suite of suites) {
  console.log('\n===== ' + suite + ' =====');
  const r = spawnSync(process.execPath, [path.join('test', suite)], { cwd: root, stdio: 'inherit', encoding: 'utf8' });
  if (r.status !== 0) failed++;
}

console.log('\n' + (failed ? '\x1b[31m' + failed + ' 个套件失败\x1b[0m' : '\x1b[32m全部通过\x1b[0m'));
process.exit(failed ? 1 : 0);
