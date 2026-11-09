#!/usr/bin/env node
/**
 * 端到端自检：一次跑完 open → view → act → act → verify → audit，
 * 每一步都断言，失败就非 0 退出。用来回答"现在到底能不能直接用"。
 *
 * 用法：node smoke.mjs [--headful]
 * 前置：先 `node agentview.mjs serve`（常驻模式），否则每次连接都会换一个浏览器。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'agentview.mjs');
const headful = process.argv.includes('--headful');

let step = 0;
const t0 = Date.now();

async function av(...args) {
  const { stdout } = await run(process.execPath, [CLI, ...args], {
    cwd: HERE, maxBuffer: 8 << 20, timeout: 120000,
  });
  return stdout.trim();
}
async function avJson(...args) {
  const out = await av(...args);
  const i = out.search(/[[{]/);
  return JSON.parse(out.slice(i));
}
function ok(label, cond, extra) {
  step++;
  const mark = cond ? 'PASS' : 'FAIL';
  console.log(`${String(step).padStart(2)}. ${mark}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) process.exitCode = 1;
}

const URL = 'https://movie.douban.com/explore';

const opened = await av('open', URL, ...(headful ? ['--headful'] : []));
ok('open 拿到视图', /nodes · .* chars/.test(opened), opened.split('\n')[2] || '');

const view = await avJson('view', '--json');
ok('视图节点数', view.stats.kept >= 30, `kept=${view.stats.kept} chars=${view.stats.view_chars}`);
ok('压缩比', view.stats.compression_x > 50, `${view.stats.compression_x}×`);

const a1 = await avJson('act', '--name', '豆瓣高分', '--json');
ok('act 豆瓣高分', a1.act.ok === true, JSON.stringify(a1.act));
ok('动作后 DOM 安静', a1.settle.settled_ms > 0 && a1.settle.settled_ms < 4000, `${a1.settle.settled_ms}ms ${a1.settle.reason}`);

const a2 = await avJson('act', '--name', '欧美', '--json');
ok('act 欧美', a2.act.ok === true, JSON.stringify(a2.act));

const v = await avJson('verify');
ok('verify 选中态', v.selected.includes('豆瓣高分') && v.selected.includes('欧美'), JSON.stringify(v.selected));

// 名字歧义：卡片里也有"韩国"，但 chip 是完全匹配，应唯一定位到 chip
const a3 = await avJson('act', '--name', '韩国', '--json');
ok('名字歧义消解', a3.act.ok === true, JSON.stringify(a3.act));

const audit = await avJson('audit');
ok('召回率', audit.recall === 1, `recall=${audit.recall} truth=${audit.truth_interactive} missed=${audit.missed}`);

const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n${process.exitCode ? '有失败项' : '全部通过'} · ${step} 项 · ${secs}s`);
