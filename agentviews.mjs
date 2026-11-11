#!/usr/bin/env node
/**
 * agentviews — Agent 的网页驱动层（CLI）
 * （v12 起产品名 agentviews；目录 / bridge-ext / 扩展 ID / window.__av 全部保持不动，
 *   避免用户重新加载已装好的扩展。命令行兼容名 agentviews 亦保留。）
 *
 * 一句话：把网页变成一份"可执行的语义视图"，Agent 用它代替截图+坐标。
 *
 * 用法：
 *   node agentviews.mjs open https://movie.douban.com/explore
 *   node agentviews.mjs view
 *   node agentviews.mjs act --name "豆瓣高分"
 *   node agentviews.mjs act --name "欧美"
 *   node agentviews.mjs verify
 *   node agentviews.mjs audit          # 召回率自检
 *   node agentviews.mjs close
 *
 * 加 --json 输出机器可读。加 --headful 开有头窗口。
 *
 * 设计约束（都是被实测逼出来的，不是偏好）：
 *  1. 用 --name 定位，不用 id。页面重建后 id 全变，名字还在。
 *  2. 动作后等 DOM 安静（settle），不等固定 sleep。
 *  3. 会离开当前页的动作（navigate/form_submit/open_new_tab）不在页内验证。
 *  4. 只碰自己开的标签页；用户的标签页一个都不动。
 */
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AvBridge } from './avbridge.mjs';
import { describeInstall } from './chrome-detect.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTRACT = join(HERE, 'extract.js');
const PORT = Number(process.env.AV_PORT || 9333);
const DAEMON = Number(process.env.AV_DAEMON || 9334);
const LOCALAPP = process.env.LOCALAPPDATA || join(process.env.USERPROFILE || '', 'AppData', 'Local');
// v1.0.1：浏览器可执行文件与 User Data 目录全部动态探测，不写死任何盘符。
// 顺序：AV_CHROME / AV_USER_DATA_DIR → 注册表 App Paths → 环境变量拼路径 → PATH。
// 桌面日常 Chrome 的 profile；Chrome 136+ 禁止在这个默认目录上开远程调试。
let _install = null;
function install() { return _install || (_install = describeInstall()); }
function defaultUserDataDir() { return install().user_data_dir; }
function browserExe() {
  const e = install().exe;
  if (!e) throw new Error('找不到 Chrome/Edge：注册表 App Paths / 环境变量 / PATH 都没命中，可设 AV_CHROME 指向可执行文件');
  return e;
}

// 宿主浏览器用 --remote-debugging-port=0 时端口是随机的，必须动态读状态文件。
// ATTACH_PORT 非空时所有 /json/* 请求都走它，不再连自己 spawn 的 9333。
let ATTACH_PORT = null;
const curPort = () => ATTACH_PORT || PORT;

// ── v10: 自有 CDP 传输（MV3 扩展 chrome.debugger + 进程内 loopback 桥）────
// chrome.debugger 是 CDP 的 alternate transport。扩展挂在用户日常桌面 Chrome，
// 被驱动的 tab 就在主浏览器窗口里 → cookies / 登录态 / 窗口天然复用，
// 不需要 --remote-debugging-port、不需要重启浏览器、不需要搬运 cookie。
const BRIDGE_PORT = Number(process.env.AV_BRIDGE_PORT || 9335);
let EXT_MODE = false;
let BRIDGE = null;
const isExt = () => EXT_MODE;
const browserLabel = () => isExt()
  ? 'desktop-main-chrome (via AgentViews CDP Bridge)'
  : (ATTACH_PORT !== null ? 'attached-chrome' : 'standalone');
// 扩展模式与 standalone 的 curPort 都是 9333，state key 必须分开，
// 否则 standalone 的 owned 清单会被误当成扩展模式的（关错用户标签页）。
const stateKey = () => isExt() ? 'ext:' + BRIDGE_PORT : String(curPort());

async function ensureBridge() {
  if (BRIDGE) return BRIDGE;
  const b = new AvBridge(BRIDGE_PORT);
  try { await b.start(); }
  catch (e) { throw new Error(`扩展桥端口 ${BRIDGE_PORT} 起不来：${e.message}。可设 AV_BRIDGE_PORT 换端口`); }
  BRIDGE = b;
  return b;
}
async function extPing(ms = 1200) {
  try { return await (await ensureBridge()).job('ping', {}, ms); }
  catch { return null; }
}
async function enableExt() {
  await ensureBridge();
  EXT_MODE = true;
  dbg('ext bridge enabled on', BRIDGE_PORT);
  return BRIDGE;
}

// 与 class CDP.send(method, params) 同构：下游 evalJs / goto / act / shot
// 一行都不用改，换掉 connect() 返回的对象即可。
class ExtTransport {
  constructor(tabId) { this.tabId = tabId; }
  async send(method, params = {}) {
    const b = await ensureBridge();
    const r = await b.job('debugger.send', { tabId: this.tabId, method, params }, 30000);
    return r || {};
  }
}

// 命令结果先攒起来再统一输出：这样同一套逻辑既能一次一进程打印，
// 也能在常驻进程里作为 JSON 返回给调用方。
let OUT = [];
const emit = s => OUT.push(typeof s === 'string' ? s : JSON.stringify(s));

const argv0 = process.argv.slice(2);
let cmd, flags = {}, positional = [];

function parse(argv) {
  const f = {}, p = [];
  // 只有这些开关带值；其余（--json / --headful / --prune ...）是布尔，
  // 后面那个 token 是命令名，不能被吞掉（踩过 `--attach pages` 被解析成 help）。
  const VALUE_FLAGS = new Set(['name', 'id', 'text', 'proxy', 'timeout', 'shot', 'port', 'state', 'idle', 'beat', 'attach', 'max', 'rounds', 'tab', 'profile']);
  // 从 0 全扫：全局开关（--attach）可以出现在命令名之前，不能假定 argv[0] 就是 cmd。
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const nxt = argv[i + 1];
      if (VALUE_FLAGS.has(k) && nxt && !nxt.startsWith('--')) { f[k] = nxt; i++; }
      else f[k] = true;
    } else p.push(a);
  }
  const c = p.shift();
  return { cmd: c, flags: f, positional: p };
}
({ cmd, flags, positional } = parse(argv0));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const dbg = (...a) => { if (process.env.AV_DEBUG) console.error('[av]', ...a); };

// ── v12「agentviews 地图」──────────────────────────────────────────
// view 是"压缩过的执行视图"（每组最多 10 条 + …+N），地图是"一级页面能力清单"：
// 不截断、按用途分组、每一项标注有什么作用（effects）。到陌生站点先跑一次 map，
// 就知道有哪些菜单 / 搜索框 / 内容入口，再决定下一步，而不是盲点。
// 全部基于已注入的 __av.nodes（recall 已验证 1.000），不新增站点适配器。
const MAP_SRC = String.raw`(()=>{
  const N = window.__av ? window.__av.nodes : [];
  const G = { search:[], navigate:[], open_item:[], account:[], action:[], content:[] };
  const NA = /(登录|注册|sign in|log in|反馈|帮助|设置|投稿|feedback|settings|help)/i;
  const SE = /(搜索|查询|search|检索|find)/i;
  for (const n of N) {
    const name = (n.name||'').trim(), role = n.role||'';
    const a = (n.actions && n.actions[0]) || {};
    const item = { handle:n.handle, name:name.slice(0,60), role, sec:n.sec,
                   effects:a.effects||[], preconditions:a.preconditions||[], confidence:n.confidence };
    if (role === 'text') { G.content.push(item); continue; }
    if (SE.test(name) || role==='textbox' || role==='combobox' || role==='searchbox') G.search.push(item);
    else if (NA.test(name)) G.account.push(item);
    else if (role==='tab' || (role==='listitem' && name.length<=8)) G.navigate.push(item);
    else if ((role==='link'||role==='button') && name.length>=12) G.open_item.push(item);
    else if (role==='button'||role==='link'||role==='checkbox'||role==='menuitem') G.action.push(item);
    else G.navigate.push(item);
  }
  const HINT = {
    search:'输入关键词并提交，检索全站内容 —— 自媒体采集的入口',
    navigate:'切换栏目 / 分类 / 榜单，改变当前数据集合',
    open_item:'打开一条内容详情（视频 / 推文 / 文章）',
    account:'登录、反馈、设置、投稿等账户与站点功能',
    action:'页内操作（筛选、展开、播放、提交等）',
    content:'可读文本块（标题、正文、指标数字）'
  };
  const caps = Object.keys(G).filter(k=>G[k].length).map(k=>({
    use:k, hint:HINT[k], count:G[k].length, nodes:G[k]
  }));
  return { site:location.href, title:document.title,
           stats:window.__av?window.__av.stats:null,
           capabilities:caps, total_nodes:N.length };
})()`;

// 结构化采集：把"阅读资讯"变成可写进表格的数据。
// 不写站点正则（那是 N×M 适配器），跨站靠"可见 + 文本够长 + 带数字"启发式。
// 关键：虚拟列表（X / 抖音 / B站）滚过一屏就卸载旧节点，所以必须
// **边滚边抓、每轮去重累积**，而不是滚完再抓（那样只剩最后一屏）。
// 指标语义靠「数字附近的标签词」判断（播放/点赞/评论/转发/时长/日期），
// 不靠"第几个数字"——那等于给每个站点写适配器。
const COLLECT_SRC = String.raw`(async()=>{
  const MAX = (window.__avCollectMax|0) || 200;
  const ROUNDS = (window.__avCollectRounds|0) || 12;
  const out=[], seen=new Set(), byHref=new Map();
  const vis=e=>{const r=e.getBoundingClientRect();if(r.width<2||r.height<2)return false;
    const s=getComputedStyle(e);return s.visibility!=='hidden'&&s.display!=='none'&&+s.opacity>0.05;};
  const txt=e=>(e.innerText||e.textContent||'').trim().replace(/\s+/g,' ');
  const DATES=/(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?|\d{1,2}月\d{1,2}日|\d+\s*(?:秒|分钟|小时|天|周|个月|年)前|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2})/gi;
  const DUR=/\b\d{1,2}:\d{2}(?::\d{2})?\b/g;
  // 标签只在数字**紧邻**处找（前 0–8 字符 / 后 0–8 字符），取距离最近的那个。
  // 用大窗口扫全文会把"卡片里任意位置的赞字"贴给每个数字，等于全标成点赞。
  const LABELS=[
    [/(播放|观看|views?|watched)/i,'播放'],
    [/(点赞|赞同|likes?|(?<![a-z])like(?![a-z]))/i,'点赞'],
    [/(评论|回复|留言|comments?|repl(?:y|ies))/i,'评论'],
    [/(转发|分享|reposts?|retweets?|shares?)/i,'转发'],
    [/(收藏|favorite|bookmark|saves?)/i,'收藏'],
    [/(弹幕|danmaku|danmu)/i,'弹幕'],
    [/(粉丝|关注者|followers?|fans)/i,'粉丝'],
    [/(stars?|星标)/i,'Star'],
    [/(播放量|观看量)/i,'播放']
  ];
  const typeMetrics=(raw)=>{
    if(!raw) return [];
    const res=[];
    // 先整体抠掉时长和日期，避免 "17:41" 被数字正则切成 17 / 41
    const durs=[...raw.matchAll(DUR)].map(m=>m[0]);
    const dates=[...raw.matchAll(DATES)].map(m=>m[0]);
    let rest=raw.replace(DUR,' ').replace(DATES,' ');
    const NUM=/\d+(?:[.,]\d+)?\s*(?:万|亿|w|W|k|K|M|B|千)?/g;
    for(const m of rest.matchAll(NUM)){
      const v=(m[0]||'').trim(); if(!/\d/.test(v)) continue;
      const at=m.index||0;
      const before=rest.slice(Math.max(0,at-8), at);
      const after=rest.slice(at+v.length, at+v.length+8);
      let label='unnamed', best=99;
      for(const pair of LABELS){
        const bm=before.match(pair[0]); if(bm){ const d=8-bm.index; if(d<best){best=d;label=pair[1];} }
        const am=after.match(pair[0]);  if(am){ const d=am.index; if(d<best){best=d;label=pair[1];} }
      }
      res.push({value:v, label, slot:res.length+1});
      if(res.length>=8) break;
    }
    for(const d of durs.slice(0,2)) if(!res.some(x=>x.value===d)) res.push({value:d,label:'时长'});
    for(const d of dates.slice(0,1)) if(!res.some(x=>x.value===d)) res.push({value:d,label:'日期'});
    return res;
  };
  const grabLinks=()=>{
    for(const a of document.querySelectorAll('a[href]')){
      if(out.length>=MAX) return;
      if(!vis(a))continue;
      const t=txt(a); if(t.length<8||t.length>400)continue;
      const href=a.href;
      // 同一个 href 在页面上常有多条 <a>：标题链一条、播放量/时长统计链一条。
      // 按 href 合并成一条，否则一屏卡片会被算成两倍条目（实测 103 条里 30 条是重复）。
      const prev=byHref.get(href);
      // 容器文本（含同级的播放量/日期）比 <a> 自己的文本信息更全
      const box=a.closest('article,li,section,[role=article],[data-testid*="cell" i],div');
      // 容器文本减去标题本身：标题里的数字（"13年的等待"）不是指标。
      // 但 B站这类"统计链接"整条 <a> 就是 "1187.5万 19.2万 02:21"，减掉就什么都不剩了，
      // 所以只在 <a> 文本确实是标题（含成段文字）时才做减法。
      const titleish=/[A-Za-z\u4e00-\u9fa5]{4,}/.test(t);
      const full=box?(titleish?txt(box).split(t).join(' '):txt(box)):t;
      const mt=typeMetrics(full);
      if(prev){
        // 合并：标题取更长的那条（标题链通常比统计链更像标题），指标取并集
        if(t.length>prev.title.length) prev.title=t.slice(0,300);
        prev.text_len=Math.max(prev.text_len,t.length);
        const have=new Set(prev.metrics_typed.map(x=>x.value+'|'+x.label));
        for(const x of mt) if(!have.has(x.value+'|'+x.label)){ prev.metrics_typed.push(x); prev.metrics.push(x.value); }
        continue;
      }
      const item={title:t.slice(0,300), href, metrics:mt.map(x=>x.value),
                  metrics_typed:mt, text_len:t.length, kind:'link'};
      byHref.set(href,item); out.push(item);
    }
  };
  const grabBlocks=()=>{
    for(const c of document.querySelectorAll('article,[role=article],[data-testid*="tweet" i],[data-testid*="cellInnerDiv" i]')){
      if(out.length>=MAX) return;
      if(!vis(c))continue;
      const t=txt(c); if(t.length<30||t.length>1200)continue;
      const key='blk|'+t.slice(0,40); if(seen.has(key))continue; seen.add(key);
      // 内容块不是链接：href 只填它自己内含的 a[href]，没有就是 null。
      // 绝不能拿 location.href 冒充"原帖链接"。
      const inner=c.querySelector('a[href]');
      const mt=typeMetrics(t);
      out.push({title:t.slice(0,400), href:inner?inner.href:null,
                metrics:mt.map(x=>x.value), metrics_typed:mt,
                text_len:t.length, kind:'content_block'});
    }
  };
  const round=()=>{ const n=out.length; grabLinks(); grabBlocks(); return out.length-n; };
  try{ await new Promise(r=>setTimeout(r,1200)); }catch(e){}
  round();
  let rounds=0, dry=0;
  for(let i=0;i<ROUNDS;i++){
    if(out.length>=MAX) break;
    rounds=i+1;
    window.scrollBy(0, Math.max(300, Math.round(window.innerHeight*0.9)));
    await new Promise(r=>setTimeout(r,900));
    const got=round();
    const atBottom=(window.innerHeight+window.scrollY)>=document.body.scrollHeight-4;
    // 到底不等于没有新内容：结果流常在到底后才追加，多给几轮。
    if(got===0){ dry++; if(dry>=3) break; } else dry=0;
    if(atBottom && got>0){ try{ await new Promise(r=>setTimeout(r,500)); }catch(e){} }
  }
  return { site:location.href, title:document.title, items:out, count:out.length,
           rounds, scroll_y:Math.round(window.scrollY),
           metric_note:'label 来自数字紧邻的标签词；label=unnamed 表示页面上只有图标没有文字，slot 是它在同类指标里的序号',
           innertext_len:(document.body?txt(document.body):'').length };
})()`;

async function httpJson(path, method = 'GET') {
  if (isExt()) {
    const b = await ensureBridge();
    if (path === '/json/list') return b.job('tabs.list', {});
    if (path.startsWith('/json/new')) {
      const q = path.includes('?') ? decodeURIComponent(path.split('?').slice(1).join('?')) : '';
      return b.job('tabs.create', { url: q || 'about:blank' });
    }
    if (path.startsWith('/json/close/')) return b.job('tabs.close', { tabId: path.slice('/json/close/'.length) });
    throw new Error('ext mode: unsupported browser op ' + path);
  }
  const r = await fetch(`http://127.0.0.1:${curPort()}${path}`, { method });
  return r.json();
}

async function browserUp() {
  if (isExt()) return !!(await extPing(1500));
  try { await httpJson('/json/version'); return true; } catch { return false; }
}

// ── attach 到已运行的浏览器 ─────────────────────────────────────────────
// 有些宿主浏览器用 --remote-debugging-port=0（端口随机），把实际端口写在
// 一个状态文件里。这里支持读这类状态文件，且每次调用都重读：
// 宿主重启换端口也不会挂死在旧端口上。
// 关键安全约束：attach 的是别人（用户）的窗口，里面有 N 个标签页，
// 全程只允许碰 OWNED 里那些由我们自己新建的 tab，绝不能 Browser.close。
const HOST_STATE = process.env.AV_HOST_STATE ||
  join(process.env.LOCALAPPDATA || join(process.env.USERPROFILE || '', 'AppData', 'Local'),
       'agentviews-host', 'browser.json');

// ── v13: 标签页选择 / 默认拉起桌面主 Chrome / 点击后能力地图 ──────────
// 多标签页的本质：多个 owned tab 同时存在，curr 指向"当前正在操作哪个"，
// 每条命令都按 curr 连接。--tab 一步切换 + 执行；tab use/new/list/close 显式管理。
async function resolveTabId(spec) {
  if (!spec) return null;
  const pages = await listPages();
  const s = String(spec);
  if (/^#?\d+$/.test(s)) {
    const n = Number(s.replace('#', ''));
    const p = pages[n - 1] || pages[0];
    return p ? p.id : null;
  }
  const hit = pages.find(p => p.id === s) || pages.find(p => p.id.startsWith(s));
  return hit ? hit.id : null;
}

async function applyTabSelection() {
  if (!flags.tab) return false;
  const id = await resolveTabId(flags.tab);
  if (!id) throw new Error('找不到标签页: ' + flags.tab + '（用 tab list 看序号）');
  await markBaseline().catch(() => {});
  const t = tabs();
  if (isAttach() && t.baseline.includes(id))
    throw new Error('拒绝切换：这是用户的标签页；agentviews 只在自己开的 tab 里活动。用 tab new 开一个');
  if (!t.owned.includes(id) && !t.baseline.includes(id)) ownTab(id);
  t.curr = id; saveTabs(); CURR = id;
  dbg('tab ->', id);
  return true;
}

async function createTab(url) {
  await markBaseline();                 // 先把用户原有页封成 baseline
  const t = tabs();
  const q = url ? encodeURIComponent(url) : 'about:blank';
  const tab = await httpJson('/json/new?' + q, 'PUT');
  if (!tab || !tab.id) throw new Error('新建标签页失败');
  if (!t.owned.includes(tab.id)) t.owned.push(tab.id);
  t.curr = tab.id; saveTabs(); CURR = tab.id;
  return tab;
}

// 点击 / 跳转 / 新标签页之后重跑一次 MAP_SRC：页面结构变了，
// 由调用方（人或 Agent）决定要不要这份新地图，不强制每次都发。
async function capabilityMap(cdp, full = false) {
  const m = await evalJs(cdp, MAP_SRC, false);
  m.product = 'agentviews';
  m.context = 'after-act';
  if (full) m.all_nodes = JSON.parse(await evalJs(cdp, 'JSON.stringify(__av.nodes)', false));
  else for (const cc of m.capabilities) { cc.total = cc.nodes.length; cc.nodes = cc.nodes.slice(0, 14); }
  return m;
}

// 没开浏览器时用桌面主 Chrome 的 Default profile 正常拉起（不带调试端口）。
// Chrome 136+ 禁止在默认 user data dir 上开 --remote-debugging-port，
// 所以这里走"启动 + 自有扩展桥 chrome.debugger"，不依赖任何端口。
// v1.0.1：exe / User Data 都来自动态探测；spawn 用 detached + unref，
// 浏览器是独立主窗口，绝不会随 av_boot 这个短命令进程一起退出。
function bootDesktop(profileName) {
  const d = install();
  if (!d.exe) throw new Error('找不到 Chrome/Edge：注册表 App Paths / 环境变量 / PATH 都没命中，可设 AV_CHROME 指向可执行文件');
  const exe = d.exe;
  const name = profileName || process.env.AV_PROFILE_NAME || 'Default';
  const args = [
    '--user-data-dir="' + d.user_data_dir + '"',
    '--profile-directory=' + name,
    '--no-first-run', '--no-default-browser-check',
    'about:blank'
  ];
  const cmdline = '"' + exe + '" ' + args.join(' ');

  // 关键：Windows 上 Node 的 spawn({detached:true}) + unref() 只让父进程不再 wait，
  // 新进程仍落在当前命令的 Job Object / 进程树里。host 取消后台任务（job_kill /
  // TerminateJobObject）会把整棵树收走 —— 用户看到的现象就是「av_boot 一结束、
  // 或相关后台任务被取消，刚拉起的主浏览器也跟着关了」。
  // 改用 WMI Win32_Process.Create：进程由 WMI 服务派生，不在我们的 Job Object 里，
  // 与 av_boot 进程、与调用它的后台任务都不再有父子/作业关系 → 浏览器真正常驻。
  let launcher = 'spawn-detached';
  let browserPid = null;
  if (process.platform === 'win32') {
    const b64 = Buffer.from(cmdline, 'utf8').toString('base64');
    const ps = [
      "$ProgressPreference='SilentlyContinue';",
      '$c=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("' + b64 + '"));',
      '$r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$c};',
      '"RET="+$r.ReturnValue+" PID="+$r.ProcessId'
    ].join(' ');
    const enc = Buffer.from(ps, 'utf16le').toString('base64');
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc],
      { encoding: 'utf8', timeout: 15000, windowsHide: true });
    const m = String(out).match(/RET=(\d+)\s+PID=(\d+)/);
    if (!m || m[1] !== '0') throw new Error('WMI 启动桌面 Chrome 失败：' + String(out).trim());
    launcher = 'wmi:Win32_Process.Create (脱离 Job Object，浏览器真正常驻)';
    browserPid = Number(m[2]);
  } else {
    const ch = spawn(exe, [
      '--user-data-dir=' + d.user_data_dir,
      '--profile-directory=' + name,
      '--no-first-run', '--no-default-browser-check', 'about:blank'
    ], { detached: true, stdio: 'ignore' });
    ch.unref();
    browserPid = ch.pid;
  }

  return {
    exe,
    exe_source: d.exe_source,
    user_data_dir: d.user_data_dir,
    profile_dir: d.user_data_dir,
    profile_name: name,
    localappdata: d.localappdata,
    cmdline,
    launcher,
    browser_pid: browserPid,
    detached: true,
    persistent: true,
    remote_debugging_port: false,
  };
}

// ── v9: 浏览器盘点 / 自动选择 ──────────────────────────────────────────
// 回答三个问题：现在开了哪些浏览器？哪个是桌面主浏览器？哪些能复用？
// 结论由实测得出，不猜：只认「进程命令行里的调试端口」+「DevToolsActivePort 文件」
// +「/json/version 真的能答」。没有这三者之一，就是不可 attach。
function flagVal(cl, name) {
  const m = cl.match(new RegExp('--' + name + '=(?:"([^"]+)"|([^\\s]+))'));
  return m ? (m[1] || m[2] || '') : '';
}
const normPath = p => (p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

function chromeRoots() {
  const out = [];
  try {
    const PS = "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -notmatch '--type=' } | ForEach-Object { $t=''; try { $t=(Get-Process -Id $_.ProcessId -ErrorAction Stop).MainWindowTitle } catch {}; $_.ProcessId.ToString() + [char]1 + $t + [char]1 + $_.CommandLine }";
    const txt = execFileSync('powershell', ['-NoProfile', '-Command', PS],
      { encoding: 'utf8', timeout: 9000, windowsHide: true });
    for (const line of txt.split(/\r?\n/)) {
      const q = line.split('\u0001');
      if (q.length < 3) continue;
      const pid = Number(q[0]);
      if (!pid) continue;
      const cl = q.slice(2).join('\u0001');
      const dp = cl.match(/--remote-debugging-port=(\d+)/);
      out.push({
        pid, title: q[1] || '', cmd: cl,
        ud: flagVal(cl, 'user-data-dir'),
        debugPort: dp ? Number(dp[1]) : null
      });
    }
  } catch (e) { dbg('chromeRoots', e.message); }
  return out;
}

function dtaPort(ud) {
  if (!ud) return 0;
  try { return Number(readFileSync(join(ud, 'DevToolsActivePort'), 'utf8').trim().split(/\s+/)[0]) || 0; }
  catch { return 0; }
}

async function probePort(port, ms = 900) {
  if (!port) return { port, alive: false };
  try {
    const opt = { signal: AbortSignal.timeout(ms) };
    const v = await (await fetch('http://127.0.0.1:' + port + '/json/version', opt)).json();
    const l = await (await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(ms) })).json();
    const pages = l.filter(t => t.type === 'page');
    return { port, alive: true, browser: v.Browser, pages: pages.length,
             titles: pages.map(p => (p.title || '').slice(0, 48)).slice(0, 6) };
  } catch { return { port, alive: false }; }
}

// 有些宿主方案不提供 CDP，而是靠一个本地桥把桌面浏览器的 cookie 单向导出到
// 它自己拉起的受管浏览器里。这里只做探测：那条桥在不在、有没有配对。
// agentviews 自己不需要它（我们有 chrome.debugger 直连），列出来只是为了
// 告诉用户「机器上还有另一套方案，它在做 cookie 搬运而不是 CDP」。
async function probeLoginBridge() {
  const port = Number(process.env.AV_COOKIE_BRIDGE_PORT) || 53820;
  const tokenFile = join(dirname(HOST_STATE), 'login-extension-token');
  const r = {
    port,
    listening: false,
    paired: null,
    token_file: existsSync(tokenFile),
    role: '第三方 cookie 导出桥（不是 CDP attach）：把桌面浏览器的登录态单向复制进它自己的受管浏览器',
  };
  try {
    // /ping 不需要 token；paired = 过去 20s 内扩展轮询过 /pending 或 /cookies。
    const v = await (await fetch('http://127.0.0.1:' + port + '/ping',
      { signal: AbortSignal.timeout(900) })).json();
    r.listening = !!v.ok;
    r.paired = !!v.paired;
  } catch { /* 桥没起 */ }
  return r;
}

async function discoverBrowsers() {
  const roots = chromeRoots();
  const candidates = [], seen = new Set();
  const add = async (port, source, extra = {}) => {
    if (!port || seen.has(port)) return;
    seen.add(port);
    const p = await probePort(port);
    candidates.push({ source, ...extra, ...p });
  };
  // 1) 宿主浏览器的状态文件（--remote-debugging-port=0 时端口写在这里）
  let hostPort = 0;
  try { hostPort = Number(JSON.parse(readFileSync(HOST_STATE, 'utf8')).port) || 0; } catch {}
  if (hostPort) await add(hostPort, 'host-state.json', { kind: 'host-managed', reusable: true });
  // 2) 显式指定
  const explicit = Number(process.env.AV_ATTACH_PORT || 0);
  if (explicit) await add(explicit, 'AV_ATTACH_PORT', { kind: 'explicit', reusable: true });
  // 3) 每个 Chrome 根进程
  const browsers = [];
  for (const r of roots) {
    const isDefault = !r.ud || normPath(r.ud) === normPath(defaultUserDataDir());
    // 非默认 profile 的 Chrome 一律算「隔离 profile」：可能是另一个自动化宿主
    // 拉起的受管实例，也可能是用户自己开的第二个 profile。两者对我们的用法一样。
    const item = {
      pid: r.pid,
      kind: isDefault ? 'desktop-main' : 'isolated-profile',
      title: r.title,
      profile: r.ud || '(default: ' + defaultUserDataDir() + ')',
      debug_flag: r.debugPort === null ? 'none' : (r.debugPort === 0 ? 'random → DevToolsActivePort' : String(r.debugPort)),
      cdp_port: (r.debugPort === 0 || r.debugPort === null) ? dtaPort(r.ud) : r.debugPort,
      attachable: false,
      why: ''
    };
    if (item.cdp_port) {
      await add(item.cdp_port, 'chrome-process:' + r.pid, { kind: item.kind, pid: r.pid, profile: item.profile });
    }
    browsers.push(item);
  }
  // 回填可达性
  for (const b of browsers) {
    const c = candidates.find(x => x.port === b.cdp_port);
    if (c && c.alive) {
      b.attachable = true;
      b.why = 'CDP 端口 ' + b.cdp_port + ' 可达';
    } else if (b.kind === 'desktop-main') {
      b.why = '没有 --remote-debugging-port；Chrome 136+ 禁止在默认 user data dir 上开远程调试，且 CDP 端口只能在进程启动时开启，运行中的浏览器无法事后追加';
    } else {
      b.why = '未发现可用 CDP 端口';
    }
  }
  const alive = candidates.filter(c => c.alive);
  // 偏好：自有扩展桥（真正直连桌面主浏览器，天然复用 cookies）
  //       > 其它可达的 CDP 端口 > 新建独立实例。
  const extBridge = await extPing(1200);
  const loginBridge = await probeLoginBridge();
  const cdpRecommend = alive[0] || null;
  const extPages = extBridge ? (await BRIDGE.job('tabs.list', {}, 1200).catch(() => [])).length : 0;
  const recommend = extBridge
    ? { mode: 'ext', port: BRIDGE_PORT, source: 'av-bridge-ext', kind: 'desktop-main-chrome', browser: 'desktop Chrome (same profile)', pages: extPages }
    : (cdpRecommend ? { mode: 'cdp', port: cdpRecommend.port, source: cdpRecommend.source, kind: cdpRecommend.kind, browser: cdpRecommend.browser, pages: cdpRecommend.pages } : null);
  return {
    chrome_root_processes: roots.length,
    install: install(),
    default_profile: defaultUserDataDir(),
    desktop_main: browsers.find(b => b.kind === 'desktop-main') || null,
    browsers,
    candidates,
    ext_bridge: {
      port: BRIDGE_PORT,
      installed: !!extBridge,
      extension: extBridge ? extBridge.extension : null,
      version: extBridge ? extBridge.version : null,
      attached: extBridge ? extBridge.attached : [],
      role: 'agentviews 自有 CDP 传输：chrome.debugger API 直接驱动桌面主 Chrome 的标签页，cookies/登录态/窗口天然复用'
    },
    login_bridge: loginBridge,
    recommend,
    advice: [
      '推荐：在 chrome://extensions 加载 agentviews/bridge-ext 一次，之后用 --ext 或 --auto 直连桌面主浏览器，无需重启、无需 --remote-debugging-port',
      '兼容路径：--attach <port> 或 AV_ATTACH_PORT=<port> 连任意已开调试端口的 Chrome',
      '运行期开关：Chrome 156 可在 chrome://inspect/#remote-debugging 勾选「Allow remote debugging for this browser instance」后连默认 profile；需每会话允许一次并显示自动化横幅'
    ],
    note: 'agentviews 的 CDP 传输来自自有 MV3 扩展（bridge-ext + chrome.debugger），直接驱动桌面主浏览器的标签页，不需要调试端口'
  };
}

async function autoAttach() {
  if (ATTACH_PORT || isExt()) return;
  const rep = await discoverBrowsers();
  if (rep.recommend && rep.recommend.mode === 'ext') {
    await enableExt();
    dbg('auto attach -> ext bridge (desktop main Chrome)');
    return;
  }
  // v13：一个 Chrome 根进程都没有 → 用 Default profile 把桌面主浏览器拉起来，
  // 等自有扩展桥上线后直连（复用登录态/代理/多用户里的常用那个）。
  if (rep.chrome_root_processes === 0) {
    const boot = bootDesktop(process.env.AV_PROFILE_NAME || 'Default');
    dbg('booted desktop chrome', boot.profile_name);
    for (let i = 0; i < 16; i++) {
      await sleep(500);
      if (await extPing(1200)) { await enableExt(); dbg('auto attach -> ext after boot'); return; }
    }
    dbg('ext bridge not up after boot; fallback standalone (independent profile)');
    return;
  }
  if (rep.recommend) {
    ATTACH_PORT = rep.recommend.port;
    dbg('auto attach ->', ATTACH_PORT, rep.recommend.source);
    return;
  }
  dbg('auto attach: will spawn standalone');
}

function resolveAttach() {
  if (isExt()) return true;         // 自有扩展桥
  if (ATTACH_PORT) return true;     // --auto 已经选好
  let port = Number(process.env.AV_ATTACH_PORT || 0);
  if (!port && flags.attach) port = Number(flags.attach) || 0;
  if (!port && flags.attach) {
    try {
      const j = JSON.parse(readFileSync(HOST_STATE, 'utf8'));
      port = Number(j.port) || 0;
    } catch (e) {
      throw new Error(`读不到宿主浏览器状态文件 (${HOST_STATE})：${e.message}。用 --attach <port> 或 AV_ATTACH_PORT 指定端口`);
    }
  }
  if (!port) return false;
  if (port !== ATTACH_PORT) {
    ATTACH_PORT = port;
    dbg('attach port', port);
  }
  return true;
}

// BASELINE / OWNED / CURR 必须落盘：attach 模式默认走「单命令」，
// 没有常驻 daemon 能替我们记住哪些 tab 是自己开的。
// 删文件/关浏览器时要格外小心——主浏览器里 N 个标签页是用户的，
// 只碰 owned 里的，baseline 永远不碰。
function stateFile() {
  return process.env.AV_STATE || (isExt()
    ? join(HERE, 'agentviews-tabs.json')                 // 自有桥：写自己目录
    : join(dirname(HOST_STATE), 'agentviews-tabs.json')); // attach/standalone：跟随宿主状态目录
}
let TABS = null;

function tabs() {
  if (TABS) return TABS;
  let s = {};
  try { s = JSON.parse(readFileSync(stateFile(), 'utf8')); } catch { /* 首次 */ }
  if (s.port !== stateKey()) s = {}; // 浏览器换了，旧清单作废
  TABS = {
    port: stateKey(),
    // baseline_set 必须是显式布尔：不能用 baseline.length 判断「有没有建立过」。
    // 第一次调用时浏览器可能是空的（baseline=[]），若用 length，则之后每次
    // 都会重新采样，把我们自己刚开的 owned tab 记成"用户的"，
    // 于是 done 永远关不掉它（这次实测就踩到了 mine:true 且 user:true）。
    baseline_set: !!s.baseline_set,
    baseline: Array.isArray(s.baseline) ? s.baseline : [],
    owned: Array.isArray(s.owned) ? s.owned : [],
    curr: s.curr || null,
  };
  return TABS;
}
function saveTabs() {
  try {
    const f = stateFile();
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify(TABS, null, 2));
  } catch (e) { dbg('saveTabs', e.message); }
}

function isAttach() { return ATTACH_PORT !== null || EXT_MODE; }

async function markBaseline() {
  const t = tabs();
  if (t.baseline_set) return;
  const live = await listPages();
  // 清掉已不存在的旧 owned（浏览器重启后 target id 全变）
  t.owned = t.owned.filter(id => live.some(p => p.id === id));
  t.baseline = live.map(p => p.id);
  t.baseline_set = true;
  if (!t.curr || !live.some(p => p.id === t.curr)) t.curr = null;
  saveTabs();
  dbg('baseline tabs', t.baseline.length, '(sealed)');
}

async function newOwnedTab() {
  await markBaseline();
  const t = tabs();
  const tab = await httpJson('/json/new?about:blank', 'PUT');
  if (!tab || !tab.id) throw new Error('新建标签页失败');
  t.owned.push(tab.id);
  t.curr = tab.id;
  saveTabs();
  dbg('owned tab +', tab.id);
  return tab;
}

function ownTab(id) {
  const t = tabs();
  if (id && !t.owned.includes(id) && !t.baseline.includes(id)) {
    t.owned.push(id);
    saveTabs();
  }
}

// 关自己开的 tab；永远拒绝 baseline。返回按关闭后复核得到的真实个数。
async function closeOwned(keepCurr = false) {
  const t = tabs();
  const live = new Set((await listPages()).map(p => p.id));
  const kill = t.owned.filter(id => live.has(id) && !t.baseline.includes(id) && (!keepCurr || id !== t.curr));
  for (const id of kill) {
    // /json/close 会在回包前把 target 掐掉，fetch 常常以 "fetch failed" 抛错，
    // 但 Chrome 其实已经关掉了。所以不靠响应计数，发完再复核 live 集合。
    await httpJson('/json/close/' + id).catch(() => {});
  }
  t.owned = t.owned.filter(id => !kill.includes(id));
  saveTabs();
  if (!kill.length) return 0;
  await sleep(200);
  const after = new Set((await listPages()).map(p => p.id));
  return kill.filter(id => !after.has(id)).length;
}

async function ensureBrowser() {
  // v10 扩展模式：浏览器就是用户的桌面主 Chrome，绝不 spawn。
  if (isExt()) {
    let ok = false;
    for (let i = 0; i < 3 && !ok; i++) ok = !!(await extPing(2500));
    if (!ok) {
      throw new Error(`自有扩展桥未就绪：请在 chrome://extensions 加载 agentviews/bridge-ext（开发者模式 → 加载已解压的扩展程序），或确认 AV_BRIDGE_PORT=${BRIDGE_PORT} 与扩展 popup 里一致`);
    }
    return 'ext';
  }
  // attach 模式：浏览器是用户/宿主的，绝不 spawn、绝不因为端口不通就自己开一个。
  if (resolveAttach()) {
    if (!(await browserUp())) {
      throw new Error(`attach 端口 ${ATTACH_PORT} 不通：目标浏览器可能已关闭。去掉 --attach 走独立浏览器模式，或确认端口`);
    }
    return 'attach';
  }
  if (await browserUp()) return 'standalone-existing';
  const exe = browserExe();
  const profile = process.env.AV_PROFILE || join(tmpdir(), 'agentviews-profile');
  const args = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    '--remote-allow-origins=*',
    '--disable-features=Translate,MediaRouter',
    '--window-size=1264,900',
    // v7：后台抓取/分析用的浏览器不该出声。进程级静音最可靠——
    // 页面里 <video>/<audio>、WebAudio、自动播放广告全都被压掉，
    // 不需要依赖页面自己有没有写 muted，也不怕注入晚于媒体创建。
    '--mute-audio',
  ];
  // v7：AV_PROXY 指向本地 HTTP 代理（例如 http://127.0.0.1:10808）。
  // 不给就直连，避免把国内站也拖进代理。
  const proxy = process.env.AV_PROXY || flags.proxy;
  if (proxy) {
    args.push('--proxy-server=' + proxy);
    args.push('--proxy-bypass-list=localhost;127.0.0.1;<-loopback>');
    dbg('proxy', proxy);
  }
  if (!flags.headful) args.push('--headless=new', '--disable-gpu');
  args.push('about:blank');
  const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    if (await browserUp()) return 'standalone-new';
  }
  throw new Error('浏览器启动超时');
}

let CURR = null; // 当前标签页 target id，daemon 进程内保存

async function listPages() {
  const list = await httpJson('/json/list');
  return list.filter(t => t.type === 'page');
}

async function pageTarget() {
  const pages = (await httpJson('/json/list')).filter(t => t.type === 'page');
  if (isAttach()) {
    // 用户主浏览器里 N 个标签页全是别人的。只允许在 owned 里活动，
    // 即便 TABS.curr 因为任何原因指到了 baseline，也直接忽略、绝不注入/导航。
    await markBaseline();
    const t = tabs();
    let mine = pages.find(p => p.id === t.curr && t.owned.includes(p.id));
    if (!mine) mine = pages.find(p => t.owned.includes(p.id));
    if (mine) { t.curr = mine.id; saveTabs(); return mine; }
    return newOwnedTab();
  }
  // v13：curr 落盘后，单命令模式切换 tab 也能保持（tabs().curr 优先）。
  const tc = tabs().curr;
  if (tc) {
    const cur = pages.find(t => t.id === tc);
    if (cur) return cur;
  }
  if (CURR) {
    const cur = pages.find(t => t.id === CURR);
    if (cur) return cur;
  }
  // 别拿第一个 about:blank：浏览器可能同时留着空白页和真正的页面，
  // 拿错了就会对着空白页注入，然后一路 ReferenceError。
  let page = pages.find(t => t.url && t.url !== 'about:blank') || pages[0];
  if (!page) {
    page = await httpJson('/json/new?about:blank', 'PUT');
  }
  return page;
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${method} timeout`)); }
      }, 30000);
    });
  }
}

let GWS = null;
let ACTIVE_CDP = null; // daemon 里当前有效的连接；切标签页时整体替换
async function connect() {
  await ensureBrowser();
  dbg('browser up');
  const page = await pageTarget();
  CURR = page.id;
  // v13：curr 落盘，单命令模式（每条命令一个新进程）也能记住"当前在哪个 tab"。
  { const t = tabs(); t.curr = page.id; saveTabs(); }
  dbg('target', page.url);
  // v10：扩展模式下没有 WebSocket，全部 CDP 命令经 loopback 桥转给
  // 扩展的 chrome.debugger.sendCommand。ExtTransport.send() 与 CDP.send() 同构。
  if (isExt()) {
    const cdp = new ExtTransport(CURR);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    // v12：我们开的 tab 是后台标签（visibilityState=hidden、hasFocus=false），
    // YouTube / X 这类 SPA 会按"不可见"做懒加载 —— 实测 YouTube 搜索页后台只渲染
    // 6–7 条视频，而前台 tab 有 77 条。用 CDP 的 focus emulation 把这个 target
    // "当作前台"，让站点完整渲染，但不抢用户窗口焦点、不切 tab、不改任何用户标签页。
    // Emulation 域在 chrome.debugger 允许列表内；失败只警告不致命（旧版 Chrome 无此命令）。
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(e => dbg('focus emulation unavailable:', e.message));
    // 桌面主 Chrome 没有 --mute-audio（也不该加进程级：会把用户所有标签页静音），
    // 用 per-target 钩子只静音我们自己开的 tab。
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: '(()=>{try{' +
        'window.__avMuted=1;' +
        'const m=HTMLMediaElement.prototype;const orig=m.play;' +
        'm.play=function(){try{this.muted=true;this.volume=0}catch(e){}return orig.apply(this,arguments)};' +
        "document.addEventListener('DOMContentLoaded',()=>{document.querySelectorAll('video,audio').forEach(v=>{v.muted=true;v.volume=0})},true);" +
        '}catch(e){}})()'
    });
    cdp.__tabId = page.id;
    dbg('ext cdp ready');
    return { cdp, page };
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  GWS = ws;
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('WebSocket 握手超时（多半是 Chrome 的 --remote-allow-origins 限制）')), 8000);
    ws.addEventListener('open', () => { clearTimeout(t); res(); });
    ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('WebSocket 握手失败')); });
  });
  dbg('ws open');
  const cdp = new CDP(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  // attach 的宿主浏览器没有 --mute-audio（也不该加，那会把用户所有
  // 标签页一起静音）。用 per-target 的 Page.addScriptToEvaluateOnNewDocument
  // 只给我们自己开的 tab 装上静音钩子：文档一创建就 hook play()，
  // 早于任何 <video>/<audio> 创建和自动播放，且作用域仅限这个 target。
  if (isAttach()) {
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(()=>{try{
        window.__avMuted=1;
        const m=HTMLMediaElement.prototype;
        const orig=m.play;
        m.play=function(){try{this.muted=true;this.volume=0}catch(e){}return orig.apply(this,arguments)};
        document.addEventListener('DOMContentLoaded',()=>{document.querySelectorAll('video,audio').forEach(v=>{v.muted=true;v.volume=0})},true);
      }catch(e){}})()`
    });
  }
  // headless 的 UA 里带 "HeadlessChrome"，不少站点（豆瓣/知乎/点评）会直接给你一份残页。
  // attach 的是正常桌面 Chrome（UA 本来就是真的），不要覆盖——
  // 覆盖是 per-target 的，但没必要把用户 tab 的 UA 改成我们硬编码的版本。
  if (!isAttach()) {
    await cdp.send('Emulation.setUserAgentOverride', {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      acceptLanguage: 'zh-CN,zh;q=0.9',
      platform: 'Win32'
    });
  }
  cdp.__tabId = page.id;
  dbg('cdp ready');
  return { cdp, page };
}

async function evalJs(cdp, expression, awaitPromise = true) {
  const r = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise, returnByValue: true, allowUnsafeEvalBlockedByCSP: true
  });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error((d.exception && (d.exception.description || d.exception.value)) || d.text);
  }
  return r.result.value;
}

let _src = null;
function src() {
  // 不缓存：daemon 是长命进程，缓存住就会对着旧提取器跑，
  // 改完 extract.js 却看不到效果（这个坑真踩过）。
  _src = readFileSync(EXTRACT, 'utf8');
  return _src;
}

async function inject(cdp) {
  return evalJs(cdp, src());
}

// 在导航中途注入会白干：__av 定义在旧 document 上，新 document 一到就蒸发了，
// 下一条命令只会收到 "ReferenceError: __av is not defined"。所以注入后要确认它还活着。
async function ensureAv(cdp) {
  let last;
  for (let i = 0; i < 4; i++) {
    try {
      last = await inject(cdp);
      const alive = await evalJs(cdp, 'typeof window.__av === "object" && !!window.__av.nodes', false);
      if (alive) return last;
    } catch { /* context 切换中 */ }
    await sleep(400);
  }
  throw new Error('注入失败：页面在导航中或上下文不可用');
}

async function waitStable(cdp) {
  // readyState=complete 不等于"渲染完了"：豆瓣/B站/必应的列表都是 JS 后渲染的。
  // 等"交互元素个数不再变化"再采样，否则会采到半成品页面（这正是第二轮必应那次指标失真的原因）。
  // v12 补：YouTube / X 这类 SPA 会先渲染稳定的外壳（导航、chip），再异步追加
  // 视频卡片 / 推文。只盯交互元素会过早收敛 → collect 只能读到首屏 6 条。
  // 因此同时盯"内容型链接数"，两者都稳定才算渲染完成。
  await sleep(900);
  let last = '', stableSince = Date.now();
  const t0 = Date.now();
  const PROBE = `(()=>{let a=document.querySelectorAll("a[href],button,input,select,textarea,[role=button]").length,c=0;
    for(const x of document.querySelectorAll("a[href]")){if((x.innerText||"").trim().length>=10)c++}
    return a+":"+c})()`;
  while (Date.now() - t0 < 12000) {
    let n;
    try { n = await evalJs(cdp, PROBE, false); }
    catch { n = last; }
    if (n !== last) { last = n; stableSince = Date.now(); }
    else if (Date.now() - stableSince >= 500) break;
    await sleep(150);
  }
  dbg('stable at', last, '(interactive:content_links)');
}

async function goto(cdp, url) {

  await cdp.send('Page.navigate', { url });
  for (let i = 0; i < 120; i++) {
    await sleep(150);
    try {
      const st = await evalJs(cdp, 'document.readyState', false);
      if (st === 'complete') break;
    } catch { /* 导航中，context 会短暂消失 */ }
  }
    await waitStable(cdp);
}


function human(stats) {
  return `${stats.kept} nodes · ${stats.view_chars} chars · ${stats.compression_x}× (HTML ${stats.outerHTML_KB} KB)`;
}

// ── v8: 登录闭环 ────────────────────────────────────────────────────────
// 只读 DOM，不改页面。need_login 用来"提示用户"，真正等登录完成交给
// login-wait 轮询，或由上层 agent 自行等待人工完成后继续。
const LOGIN_PROBE = `(() => {
  const hints = [];
  const push = (s) => { if (s && hints.length < 8 && !hints.includes(s)) hints.push(s); };
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const body = (document.body && document.body.innerText || '').slice(0, 4000);
  const url = location.href;
  const urlHit = /(login|signin|passport|accounts\\.google|\\/auth\\/|\\/sso|oauth)/i.test(url);
  let pw = 0, named = 0, modal = 0;
  for (const el of document.querySelectorAll('input[type=password]')) if (vis(el)) { pw++; push('password input'); }
  const words = /^(登录|登陆|立即登录|扫码登录|验证码登录|帐号登录|账号登录|登入|登录\\/注册|Sign in|Log in|Sign up)$/i;
  for (const el of document.querySelectorAll('button,a,[role=button],input[type=submit],span,div')) {
    if (!vis(el)) continue;
    const t = (el.textContent || el.value || '').trim().slice(0, 24);
    if (words.test(t)) { named++; push(t); }
  }
  for (const el of document.querySelectorAll('[class*=login i],[id*=login i],[class*=modal i],[role=dialog],[class*=dialog i],[class*=qrcode i]')) {
    if (vis(el)) modal++;
  }
  const loggedIn = !!document.querySelector('[class*=avatar i],[class*=user-info i],[class*=userinfo i],[class*=logout i]') ||
    /(退出登录|注销|我的账号|我的账户|Sign out|Log out)/.test(body);
  const need_login = !loggedIn && (pw > 0 || named > 0 || urlHit || (modal > 0 && /登录|登入|Sign in/i.test(body)));
  return { need_login, logged_in: loggedIn, url, password_inputs: pw, login_named: named, login_containers: modal, hints };
})()`;

function loginProbe(cdp) { return evalJs(cdp, LOGIN_PROBE, false); }

// ── v9: 事件驱动的登录等待 / 空闲休眠 ──────────────────────────────────
// 用户思路：登录时人一定会在页面上产生动作；监听到动作再判断登录是否成功。
// 长时间没动作就「临时冻结 + 保留心跳」，发现动作再激活 —— 和 Chrome 的
// tab discarding / freezing 一个思路。attach 长连接正好这样用：WS 不关、
// 但空闲时空转降到最低。
// 关键区分：真实用户输入（决定休眠/激活） vs 页面自身 DOM 变化（弹幕轮播
// 也算变化，但不能因此认为「人在操作」；它只用来触发一次登录判定）。
const WATCH_SRC = `(()=>{
  if (window.__avWatch) return 'already';
  const s = { u: Date.now(), d: Date.now(), un: 0, dn: 0, url: location.href,
              vis: document.visibilityState, kinds: [], installed: Date.now() };
  window.__avWatch = s;
  const bump = (key, user) => {
    const t = Date.now();
    if (user) { s.u = t; s.un++; } else { s.d = t; s.dn++; }
    if (s.kinds.length < 12 && !s.kinds.includes(key)) s.kinds.push(key);
  };
  for (const e of ['pointerdown','keydown','input','change','click','focusin','submit','wheel','touchstart'])
    window.addEventListener(e, () => bump(e, true), true);
  document.addEventListener('visibilitychange', () => {
    s.vis = document.visibilityState; bump('visibilitychange', true);
  }, true);
  try {
    new MutationObserver(ms => { if (ms.length) bump('dom', false); })
      .observe(document.documentElement, { childList:true, subtree:true, attributes:true, characterData:true });
  } catch (e) {}
  setInterval(() => { if (location.href !== s.url) { s.url = location.href; bump('navigation', false); } }, 400);
  return 'installed';
})()`;

// 短超时 evaluate：frozen 时 Runtime.evaluate 会挂住渲染进程，用 1s 超时探测
// 「Chrome 是否已经因为用户操作把 tab 自动解冻」。
function evalTimeout(cdp, expr, ms) {
  const p = evalJs(cdp, expr, false);
  p.catch(() => {});
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error('eval-timeout')), ms))
  ]);
}

async function watchLogin(cdp, opts) {
  const { timeoutSec = 300, idleSec = 12, beatSec = 5, freeze = false } = opts;
  const t0 = Date.now();
  const events = [];
  const log = (kind, x = {}) => {
    const e = { at_ms: Date.now() - t0, kind, ...x };
    events.push(e);
    dbg('watch', JSON.stringify(e));
  };
  await evalJs(cdp, WATCH_SRC, false);
  let probe = await loginProbe(cdp);
  const first = probe;
  log('start', { need_login: probe.need_login, logged_in: probe.logged_in, url: probe.url });

  let state = 'active', frozen = false;
  let lastUn = -1, lastDn = -1, lastCheckedDn = -1, lastCheckedUn = -1;
  let lastUserAt = Date.now();
  let result = null;

  while (Date.now() - t0 < timeoutSec * 1000) {
    await sleep(state === 'dormant' ? beatSec * 1000 : 400);
    let raw = null;
    try { raw = await evalTimeout(cdp, 'JSON.stringify(window.__avWatch||null)', 1000); }
    catch { /* frozen 或导航中 */ }
    if (raw === null || raw === undefined) {
      if (frozen) { log('heartbeat-frozen'); continue; }
      try { await evalJs(cdp, WATCH_SRC, false); log('reinstalled'); } catch {}
      continue;
    }
    if (frozen) {
      // 能 eval 说明 Chrome 已把 tab 解冻（用户切回来 / 点了页面）
      await cdp.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
      frozen = false; state = 'active'; lastUserAt = Date.now();
      log('thawed', { by: 'chrome-auto-unfreeze' });
    }
    // 休眠期每个心跳都留一条痕：证明 WS 还连着、tab 还活着，而不是"进程死了没人知道"。
    if (state === 'dormant') log('heartbeat', { at_ms: Date.now() - t0, frozen });
    let W;
    try { W = JSON.parse(raw); } catch { continue; }
    if (!W || !W.u) { try { await evalJs(cdp, WATCH_SRC, false); } catch {} continue; }

    if (W.un !== lastUn) {
      if (lastUn >= 0) log('user-activity', { un: W.un, kinds: W.kinds });
      lastUn = W.un; lastUserAt = Date.now();
      if (state === 'dormant') { state = 'active'; log('reactivated', { reason: 'user-activity' }); }
    }
    if (W.dn !== lastDn) { if (lastDn >= 0) log('page-change', { dn: W.dn, url: W.url }); lastDn = W.dn; }

    // 只有「用户有动作」或「页面有变化」才跑一次全量 DOM 判定。
    // 不再每 1.5s 扫一遍整页 —— 空闲时 CDP 往返趋近于零。
    if (W.dn !== lastCheckedDn || W.un !== lastCheckedUn) {
      lastCheckedDn = W.dn; lastCheckedUn = W.un;
      try {
        probe = await loginProbe(cdp);
        log('probe', { need_login: probe.need_login, logged_in: probe.logged_in, url: probe.url });
        if (!probe.need_login) { result = 'login_done'; break; }
      } catch { /* 导航中 */ }
    }

    if (state === 'active' && Date.now() - lastUserAt > idleSec * 1000) {
      state = 'dormant';
      log('dormant', { idle_ms: Date.now() - lastUserAt, heartbeat_ms: beatSec * 1000, freeze });
      if (freeze) {
        try { await cdp.send('Page.setWebLifecycleState', { state: 'frozen' }); frozen = true; log('frozen'); }
        catch (e) { log('freeze-unsupported', { error: e.message }); }
      }
    }
  }
  return {
    result: result || (probe && !probe.need_login ? 'login_done' : 'timeout_still_login'),
    waited_ms: Date.now() - t0,
    was_need_login: first.need_login,
    now_need_login: probe ? probe.need_login : first.need_login,
    logged_in: probe ? probe.logged_in : false,
    url: probe ? probe.url : first.url,
    final_state: state,
    idle_sec: idleSec, heartbeat_sec: beatSec, freeze_requested: freeze,
    events,
    advice: (result || (probe && !probe.need_login))
      ? '登录完成，可继续任务'
      : '仍未登录：请在浏览器窗口完成登录；探针会在检测到你的操作时自动再次判定'
  };
}

// standalone 时整个浏览器是我们 spawn 的，可以整体关；attach 时绝不调用它。
async function closeBrowser() {
  try {
    const v = await httpJson('/json/version');
    const ws = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('browser ws timeout')), 5000);
      ws.addEventListener('open', () => { clearTimeout(t); res(); });
      ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('browser ws error')); });
    });
    // 发完就走：Browser.close 会在回包前把连接掐断，await 会白等 30s。
    ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    await sleep(300);
    try { ws.close(); } catch { /* ignore */ }
    return true;
  } catch (e) { dbg('closeBrowser', e.message); return false; }
}

// 分级收尾：keep = 辅助性（保留窗口，只反馈）；done = 任务性（销毁）。
// attach 下 destroy 只关 owned 标签页，baseline（用户原有 tab）一个都不碰。
async function finish(mode) {
  if (mode === 'keep') {
    const t = isAttach() ? tabs() : null;
    // v1.0.1：保留标签页的同时显式 detach，消掉「正在调试此浏览器」信息栏；
    // 下一条 --ext 命令会按需重新 attach（attachTab 能处理 already attached）。
    let detached = 0;
    if (isExt()) {
      try { const r = await BRIDGE.job('debugger.detachAll', {}, 4000); detached = r.detached || 0; }
      catch (e) { dbg('detachAll on keep', e.message); }
    }
    emit(JSON.stringify({
      mode: 'keep', kept: true,
      browser: browserLabel(),
      owned_tabs: t ? t.owned.length : null,
      curr: t ? t.curr : CURR,
      debugger_detached: detached,
      note: t ? '只保留自己开的标签页；用户主窗口与其它标签页完全未动' : '独立窗口保留，可继续下令'
    }, null, 2));
    return;
  }
  if (isAttach()) {
    const closed = await closeOwned(false);
    const t = tabs(); t.curr = null; saveTabs();
    // v10：显式 detach，消掉 chrome.debugger 的「正在调试此浏览器」信息栏；
    // 不 detach 会留下 orphaned attachment，信息栏永不消失（已查证公开 bug）。
    let detached = 0;
    if (isExt()) {
      try { const r = await BRIDGE.job('debugger.detachAll', {}, 4000); detached = r.detached || 0; }
      catch (e) { dbg('detachAll', e.message); }
    }
    emit(JSON.stringify({ mode: 'done', browser: browserLabel(), closed_owned_tabs: closed, debugger_detached: detached, user_tabs_untouched: true }));
  } else {
    const ok = await closeBrowser();
    emit(JSON.stringify({ mode: 'done', browser: 'standalone', browser_closed: ok }));
  }
}

let IN_DAEMON = false;
let DAEMON_SERVER = null;
let SHUTTING = false;

// 常驻 daemon 的退出路径：先关 WebSocket / HTTP server，睡一小会儿让 libuv
// 把 closing 句柄收掉，再 exit。直接 process.exit 会踩
// "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76"。
// 关的是 daemon 进程自己，attach 模式下用户的主浏览器一个标签页都不会被碰。
async function shutdown(code = 0) {
  if (SHUTTING) return;
  SHUTTING = true;
  dbg('shutdown daemon', code);
  try { GWS && GWS.close(); } catch { /* ignore */ }
  try { BRIDGE && BRIDGE.close(); } catch { /* ignore */ }
  try { DAEMON_SERVER && DAEMON_SERVER.close(); } catch { /* ignore */ }
  await sleep(150);
  process.exit(code);
}

async function main(cdpIn) {
  OUT = [];
  // v1.0.1：boot 只做一件事——把桌面主 Chrome 常驻拉起，然后让本进程立刻结束。
  // 不 connect、不起扩展桥、不切 tab：桥是「下一条命令」的进程起的，
  // 这样短命令退出时也带不走任何东西；浏览器 detached+unref 独立存活。
  // 目的：扩展桥上线后经 chrome.debugger 直连这个主浏览器，复用登录态。
  if (cmd === 'boot') {
    const before = chromeRoots().length;
    const r = bootDesktop(flags.profile || process.env.AV_PROFILE_NAME || 'Default');
    emit(JSON.stringify({
      booted: true,
      chrome_root_processes_before: before,
      ...r,
      browser_persistent: true,
      av_boot_process_exits: true,
      next: '浏览器常驻；后续 av_open / av_map / ... 由扩展桥起 9335 后走 chrome.debugger 直连，不必再启动浏览器',
    }, null, 2));
    return;
  }
  // v10：显式 --ext 直接启用自有扩展桥；--auto 由 discoverBrowsers 优先选扩展桥。
  if (flags.ext || process.env.AV_EXT === '1') await enableExt();
  else if (flags.auto || process.env.AV_AUTO === '1') await autoAttach();
  // 每条命令都重读一次：宿主重启会换随机端口，daemon 不重读就会挂在旧端口上。
  resolveAttach();
  // v13：--tab 可以在任意命令前切到指定标签页（幂等，serve 里也会先跑一次）。
  await applyTabSelection();
  if (!cmd || cmd === 'help' || flags.help) {
    emit(`agentviews — Agent 的网页驱动层（v1.0.1）

  一级页面能力地图（先知道有什么，再决定做什么）
  map [--full] [--json] 能力地图：搜索框/菜单/内容入口/账户，按用途分组并标注作用
                         --full 附全量节点；不带则只给一级能力
  search <关键词>       从地图找到搜索框 → 填词 → 提交 → 返回新页视图（复用当前 tab）
  collect [--json]      把当前页读成结构化数据（标题/链接/指标），替代被反爬卡死的爬虫

  执行视图
  open <url>            打开页面并注入视图（复用当前 tab 导航，不新开窗口）
  view [--json]         打印压缩语义视图
  find <substr>         按名字搜索节点
  act --name <名字>     按名字点击（也可 --id n28）；加 --map 附带点击后的新页能力地图
  act --name <名字> --text <值>   填输入框
  verify                读页面状态（选中项 / 列表）
  audit                 召回率自检（需要真值选择器）
  多标签页（多个任务各自一个 tab，互不干扰）
  tab new [url]         新建自己的标签页并切过去（可选直接打开 url）
  tab use <id|#序号>    切到指定标签页（只许切到 agentviews 自己开的）
  tab list              列出所有标签页，标 index / mine / user / curr
  tab close [id|#序号]  关掉指定的自己开的标签页（拒绝关用户的）
  --tab <id|#序号>      任意命令前加它 = 先切过去再执行
  boot [--profile 名]   动态探测 Chrome 安装位置/User Data，拉起桌面主 Chrome 后本进程即退（浏览器常驻）

  浏览器 / 会话
  serve                 常驻模式（standalone 专用；attach 走单命令，用完即退）
  pages                 列出/清理标签页（attach 下只清自己开的）
  shot [path]           截图（给人看：扫码、验证码）
  login-check [--shot]  检测是否需要登录（非阻塞，返回 need_login/hints）
  login-wait [--timeout 秒]  等用户登录（v9 改为事件驱动 + 空闲休眠心跳）
  login-watch [--timeout 秒] [--idle 秒] [--beat 秒] [--freeze]
                         监听页面活动/变化判断登录；空闲冻结保活、有操作再激活
  probe                 盘点所有 Chrome + 自有扩展桥 + 桌面主浏览器为何不能直连
  keep                  辅助性收尾：保留窗口/标签页，只反馈结果
  done                  任务性收尾：销毁自己开的标签页(attach)或整窗(standalone)，并停 daemon
  stop                  停掉常驻 daemon（不销毁浏览器）
  close                 同 done（兼容旧用法）

  --ext / AV_EXT=1       自有 CDP 传输：经 bridge-ext 直连桌面主浏览器（推荐）
  --attach <port>        attach 到任意已开调试端口的 Chrome（复用登录态）
  --auto / AV_AUTO=1     自动挑：自有扩展桥 > 拉起桌面主 Chrome(Default) > 可达 CDP 端口 > 独立窗口
  AV_ATTACH_PORT=<port> 直接指定 attach 端口，跳过宿主状态文件
  AV_BRIDGE_PORT=<port> 扩展桥端口（默认 9335，需与扩展 popup 一致）
  AV_PROFILE_NAME=<名>   boot/--auto 拉起桌面主 Chrome 时用哪个 profile（默认 Default）
  AV_PROFILE=<dir>       standalone 独立窗口的 user-data-dir
  AV_CHROME=<exe>        手动指定浏览器可执行文件（默认动态探测：注册表 App Paths → 环境变量 → PATH）
  AV_USER_DATA_DIR=<dir> 手动指定桌面主浏览器 User Data（默认按 LOCALAPPDATA + 产品名推导）
  --json / --headful / AV_DEBUG=1 / AV_PROXY=... / AV_IDLE_MS=...
  命令行简写：npm link 之后 avs == agentviews`);
    return;
  }

  // 不需要页面、也不需要 connect() 的命令（connect 会新建标签页，收尾时不能踩）
  if (cmd === 'stop') {
    if (IN_DAEMON) { setTimeout(() => shutdown(0), 200); emit('stopping daemon (browser left intact)'); }
    else emit('no daemon running');
    return;
  }
  if (cmd === 'keep' || cmd === 'done' || cmd === 'close') {
    await finish(cmd === 'keep' ? 'keep' : 'done');
    if (cmd !== 'keep' && IN_DAEMON) setTimeout(() => shutdown(0), 250);
    return;
  }

  if (cmd === 'probe') {
    const r = await discoverBrowsers();
    if (flags.json) return emit(JSON.stringify(r, null, 2));
    const main = r.desktop_main;
    emit('# 浏览器盘点  chrome 根进程 ' + r.chrome_root_processes + ' 个');
    emit('# 动态探测: exe=' + r.install.exe + '  ← ' + r.install.exe_source);
    emit('#            user_data_dir=' + r.install.user_data_dir + '  (LOCALAPPDATA=' + r.install.localappdata + ')');
    for (const b of r.browsers) {
      emit('#  pid=' + b.pid + '  ' + b.kind + '  cdp=' + (b.cdp_port || 'none') +
           '  attachable=' + b.attachable + '  ' + (b.title || '').slice(0, 46));
      emit('#    profile=' + b.profile);
      emit('#    ' + b.why);
    }
    if (main && !main.attachable) {
      emit('# 桌面主浏览器 (pid ' + main.pid + ') 不可连接：' + main.why);
    }
    const eb = r.ext_bridge;
    emit('# 自有扩展桥: 127.0.0.1:' + eb.port + ' installed=' + eb.installed +
         (eb.installed ? ' ext=' + eb.extension + ' v' + eb.version + ' attached=' + eb.attached.length : ' → 在 chrome://extensions 加载 agentviews/bridge-ext'));
    emit('#   ' + eb.role);
    const lb = r.login_bridge;
    emit('# 登录桥: 127.0.0.1:' + lb.port + ' listening=' + lb.listening +
         ' paired=' + lb.paired + ' token_file=' + lb.token_file);
    emit('#   ' + lb.role);
    emit('# 结构: ' + r.note);
    emit('# 可复用: ' + (r.recommend
      ? (r.recommend.mode === 'ext' ? '自有扩展桥 (--ext, 直连桌面主浏览器, ' + r.recommend.pages + ' tabs)' : 'port ' + r.recommend.port + ' (' + r.recommend.source + ', ' + r.recommend.browser + ', ' + r.recommend.pages + ' tabs)')
      : '无 → --auto 会新建独立窗口'));
    for (const a of r.advice) emit('# 建议: ' + a);
    return;
  }

  if (cmd === 'tab') {
    const sub = positional[0] || 'list';
    await markBaseline().catch(() => {});
    const t = tabs();
    if (sub === 'new') {
      const tab = await createTab(positional[1]);
      const pages = await listPages();
      emit(JSON.stringify({ action: 'new', id: tab.id, index: pages.findIndex(p => p.id === tab.id) + 1,
        url: tab.url || 'about:blank', curr: tab.id, owned: t.owned.length }, null, 2));
      return;
    }
    if (sub === 'use') {
      const spec = positional[1];
      if (!spec) throw new Error('tab use 需要 id 或 #序号（tab list 可查）');
      const id = await resolveTabId(spec);
      if (!id) throw new Error('找不到标签页: ' + spec);
      if (isAttach() && t.baseline.includes(id))
        throw new Error('拒绝切换：这是用户的标签页；agentviews 只在自己开的 tab 里活动。用 tab new 开一个');
      if (!t.owned.includes(id) && !t.baseline.includes(id)) ownTab(id);
      t.curr = id; saveTabs(); CURR = id;
      const p = (await listPages()).find(x => x.id === id);
      emit(JSON.stringify({ action: 'use', id, url: p ? p.url : null, owned: t.owned.length }, null, 2));
      return;
    }
    if (sub === 'close') {
      const id = await resolveTabId(positional[1] || t.curr);
      if (!id) throw new Error('找不到要关的标签页');
      if (t.baseline.includes(id)) throw new Error('拒绝关闭：这是用户的标签页（baseline 永久保护）');
      if (isAttach() && !t.owned.includes(id)) throw new Error('拒绝关闭：不是 agentviews 开的标签页');
      await httpJson('/json/close/' + id).catch(() => {});
      t.owned = t.owned.filter(x => x !== id);
      if (t.curr === id) t.curr = null;
      saveTabs();
      await sleep(200);
      const gone = !(await listPages()).some(p => p.id === id);
      emit(JSON.stringify({ action: 'close', id, closed: gone, user_tabs_untouched: true }, null, 2));
      return;
    }
    const pages = await listPages();
    emit(JSON.stringify({
      browser: browserLabel(), curr: t.curr, owned: t.owned.length, baseline: t.baseline.length,
      tabs: pages.map((p, i) => ({ index: i + 1, id: p.id, url: (p.url || '').slice(0, 100),
        title: (p.title || '').slice(0, 50), curr: p.id === t.curr,
        mine: t.owned.includes(p.id), user: t.baseline.includes(p.id) }))
    }, null, 2));
    return;
  }

  if (cmd === 'pages') {
    const list = await listPages();
    if (isAttach()) await markBaseline();
    const t = isAttach() ? tabs() : null;
    if (flags.prune) {
      let closed;
      if (isAttach()) {
        // 只关自己开的，保留当前；用户的 baseline 一个都不碰。
        closed = await closeOwned(true);
      } else {
        const keep = CURR || (await pageTarget()).id;
        closed = 0;
        for (const x of list) {
          if (x.id === keep) continue;
          try { await httpJson('/json/close/' + x.id); closed++; } catch { /* 已关 */ }
        }
        CURR = keep;
      }
      emit(JSON.stringify({ before: list.length, closed, mode: isAttach() ? 'attach-owned-only' : 'standalone', kept_curr: isAttach() ? t.curr : CURR }, null, 2));
      return;
    }
    const cur = isAttach() ? t.curr : CURR;
    emit(JSON.stringify({
      browser: browserLabel(),
      curr: cur,
      baseline: isAttach() ? t.baseline.length : null,
      owned: isAttach() ? t.owned.length : null,
      tabs: list.map(x => ({ id: x.id, url: (x.url || '').slice(0, 100), active: x.id === cur, mine: isAttach() ? t.owned.includes(x.id) : null, user: isAttach() ? t.baseline.includes(x.id) : null }))
    }, null, 2));
    return;
  }

  const cdp = cdpIn || (await connect()).cdp;

  if (cmd === 'open') {
    // open 之后当前标签页就是新页，记下来
    const url = positional[0];
    if (!url) throw new Error('需要 URL');
    await goto(cdp, url);
    const stats = await ensureAv(cdp);
    if (flags.json) return emit(JSON.stringify(stats, null, 2));
    const title = await evalJs(cdp, 'document.title', false);
    emit(`# ${title}\n# ${url}\n# ${human(stats)}\n`);
    emit(await evalJs(cdp, 'window.__av.view', false));
    return;
  }

  // 其余命令：先注入拿最新视图
  await ensureAv(cdp);

  // ── v12「agentviews 地图」────────────────────────────────────────
  if (cmd === 'map') {
    const m = await evalJs(cdp, MAP_SRC, false);
    m.product = 'agentviews';
    m.full = !!flags.full;
    // 地图是「能力清单」不是「再发一遍整棵树」：默认每类只留前 14 个样例，
    // 需要全量节点才用 --full。否则 B 站这类页面光 map 就 17–25k 字符，
    // 比传统通道整棵 a11y 树还贵，违背"先轻量看清页面有什么"的初衷。
    if (flags.full) m.all_nodes = JSON.parse(await evalJs(cdp, 'JSON.stringify(__av.nodes)', false));
    else for (const c of m.capabilities) { c.total = c.nodes.length; c.nodes = c.nodes.slice(0, 14); }
    if (flags.json) return emit(JSON.stringify(m, null, 2));
    emit('# agentviews 地图  ' + m.site);
    emit('# ' + m.title + '  ·  ' + m.total_nodes + ' 个能力节点');
    for (const c of m.capabilities) {
      emit('');
      emit('## ' + c.use + '  (' + c.count + ')  — ' + c.hint);
      for (const x of c.nodes.slice(0, 14)) {
        emit('  ' + String(x.handle || '').slice(0, 44).padEnd(44) + ' ' +
             String(x.name || '').slice(0, 40) + '  [' + (x.effects || []).join(',') + ']');
      }
      if (c.count > c.nodes.length) emit('  …+' + (c.count - c.nodes.length));
    }
    return;
  }

  // 结构化采集：把"阅读资讯"变成可写进表格的数据。
  if (cmd === 'collect') {
    // 边滚边抓：虚拟列表滚过一屏就卸载旧节点，滚完再抓只剩最后一屏。
    // 上限与轮数可由调用方收紧（--max / --rounds），默认 200 条 / 12 轮。
    if (flags.max) await evalJs(cdp, 'window.__avCollectMax=' + (Number(flags.max) || 0), false).catch(() => {});
    if (flags.rounds) await evalJs(cdp, 'window.__avCollectRounds=' + (Number(flags.rounds) || 0), false).catch(() => {});
    const r = await evalJs(cdp, COLLECT_SRC, true);
    if (flags.json) return emit(JSON.stringify(r, null, 2));
    emit('# 结构化采集  ' + r.site + '  ·  ' + r.count + ' 条  ·  ' + r.rounds + ' 轮  ·  正文 ' + r.innertext_len + ' 字');
    emit('# href=null 表示这是内容块（正文），不是一条可跳转的条目');
    for (const it of r.items.slice(0, 30)) emit(JSON.stringify(it));
    if (r.count > 30) emit('# …+' + (r.count - 30) + ' 条，用 --json 取全量');
    return;
  }

  // 搜索 → 阅读 → 整理 的第一步：地图找搜索框，填词，提交，回新页视图。
  // 全程复用同一个 tab（Page.navigate），不新开也不关闭窗口。
  if (cmd === 'search') {
    const kw = positional.join(' ').trim();
    if (!kw) throw new Error('需要搜索关键词：agentviews search 军事新闻');
    const m = await evalJs(cdp, MAP_SRC, false);
    const box = (m.capabilities.find(c => c.use === 'search') || {}).nodes?.[0];
    const detail = { product: 'agentviews', keyword: kw, from: m.site,
                     search_box: box ? box.name : null, reused_tab: true };
    if (box) {
      detail.fill = JSON.parse(await evalJs(cdp,
        `JSON.stringify(__av.act(${JSON.stringify({ name: box.name, verb: 'set_value', text: kw })}))`, false));
      // 搜索框在 form 里，untrusted keydown 会被丢；派可信 Enter。
      const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key }).catch(() => {});
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key }).catch(() => {});
      await sleep(900);
    }
    const urlAfter = await evalJs(cdp, 'location.href', false).catch(() => m.site);
    if (!box || urlAfter === m.site) {
      // 兜底：构造搜索 URL 复用当前 tab 导航（不是新开窗口，也不算站点适配器，
      // 只是三个已知站点的搜索入口常量；未知站点走 /search?q=）。
      let host = m.site; try { host = new URL(m.site).hostname; } catch {}
      const SEARCH_URL = {
        'x.com': 'https://x.com/search?q=' + encodeURIComponent(kw) + '&src=typed_query&f=live',
        'www.youtube.com': 'https://www.youtube.com/results?search_query=' + encodeURIComponent(kw),
        'youtube.com': 'https://www.youtube.com/results?search_query=' + encodeURIComponent(kw),
        'www.bilibili.com': 'https://search.bilibili.com/all?keyword=' + encodeURIComponent(kw)
      };
      const target = SEARCH_URL[host] || (m.site.replace(/\/$/, '') + '/search?q=' + encodeURIComponent(kw));
      await goto(cdp, target);
      detail.fallback_navigate = target;
    } else {
      await waitStable(cdp);
    }
    await ensureAv(cdp);
    const stats = await evalJs(cdp, 'window.__av.stats', false);
    detail.url = await evalJs(cdp, 'location.href', false);
    detail.stats = stats;
    if (flags.json) {
      detail.view = await evalJs(cdp, 'window.__av.view', false);
      return emit(JSON.stringify(detail, null, 2));
    }
    emit('# agentviews search  ' + kw + '  →  ' + detail.url);
    emit('# ' + human(stats));
    emit(await evalJs(cdp, 'window.__av.view', false));
    return;
  }

  if (cmd === 'view') {
    if (flags.json) {
      return emit(JSON.stringify(await evalJs(cdp, '({stats:__av.stats, nodes:__av.nodes})', false), null, 2));
    }
    emit(await evalJs(cdp, 'window.__av.view', false));
    return;
  }

  if (cmd === 'find') {
    const q = positional[0] || '';
    // 纯文本节点（role:'text'）的 actions 是空数组，直接取 actions[0].effects 会
    // 抛 "Cannot read properties of undefined"。这里统一按「无动作」处理。
    const hits = await evalJs(cdp, `JSON.stringify(__av.byName(${JSON.stringify(q)}).slice(0,20).map(n=>{
      const a=(n.actions&&n.actions[0])||{};
      return {id:n.id,handle:n.handle,sec:n.sec,role:n.role,eff:a.effects||[],pre:a.preconditions||[],clickable:!!a.verb};
    }))`, false);
    emit(hits);
    return;
  }

  if (cmd === 'act') {
    const name = flags.name, id = flags.id;
    if (!name && !id) throw new Error('需要 --name 或 --id');
    const payload = { verb: flags.text ? 'set_value' : 'click' };
    if (name) payload.name = name; else payload.id = id;
    if (flags.text) payload.text = flags.text;
    const expr = `JSON.stringify(__av.act(${JSON.stringify(payload)}))`;
    dbg('act expr', expr);
    const before = new Set((await listPages()).map(t => t.id));
    const res = JSON.parse(await evalJs(cdp, expr, false));
    let clicked = null;
    if (res.ok && res.point) {
      const [px, py] = res.point;
      const base = { x: px, y: py, button: 'left', clickCount: 1 };
      // v7.1：CDP 可信点击会在常驻 daemon 会话里「静默丢事件」——
      // Input.dispatchMouseEvent 三条都返回 ok，但 document 上一个 click 都没收到，
      // 于是 settle 白等满 4s、act 返回 ok:true 而世界没变（静默失败的典型形态）。
      // 根因与窗口激活状态/会话绑定有关，不去猜；改成「先派可信事件，再验证是否落地，
      // 没落地就用合成 click 兜底」。两条路都保住：B站/YouTube 的 window.open
      // 依赖用户激活（可信事件成功时不会进兜底），豆瓣筛选 chip 直接 listener 用合成就够。
      await evalJs(cdp, `(()=>{window.__avClicks=[];if(!window.__avArmed){window.__avArmed=1;document.addEventListener('click',function(e){if(e.isTrusted)window.__avClicks.push([e.clientX,e.clientY])},true)}return 1})()`, false).catch(() => {});
      // bringToFront 单独容错：某些 headless/无窗口场景不支持它，不能因此把整次点击废掉。
      await cdp.send('Page.bringToFront').catch(() => {});
      try {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
        clicked = 'cdp-trusted';
      } catch (e) {
        clicked = 'failed:' + e.message;
      }
      await sleep(80);
      const landed = await evalJs(cdp, '(()=>{try{return (window.__avClicks||[]).length>0}catch(e){return false}})()', false).catch(() => false);
      if (!landed) {
        const fb = await evalJs(cdp, `(()=>{var h=window.__avLastHit;if(!h||!h.isConnected)return 'NO_HIT';h.click();return 'ok'})()`, false).catch(e => 'ERR:' + e.message);
        clicked = 'synthetic-fallback:' + fb;
      }
    }
    // 动作没成功就别等 DOM 安静了——没有变更，settle 只会白等满 4 秒。
    // 点了会跳走的元素（<a href>）也别等：整页导航之后 __av 已经随旧 document 蒸发了，
    // settle 会抛 ReferenceError，把一次成功的点击报成失败。
    let settled;
    if (!res.ok) {
      settled = JSON.stringify({ settled_ms: 0, reason: 'skipped' });
    } else {
      try {
        settled = await evalJs(cdp, `__av.settle(4000).then(r => JSON.stringify(r))`, true);
      } catch {
        settled = JSON.stringify({ settled_ms: 0, reason: 'navigated' });
      }
    }
    // 有些站点（B站点卡片）是 target=_blank：当前页纹丝不动，动作在另一个标签页里发生。
    // 不跟过去，后面每一条命令都对着旧页面 verify，看起来就像"点了没反应"。
    const fresh = (await listPages()).find(t => !before.has(t.id));
    if (fresh) {
      CURR = fresh.id;
      // v8：target=_blank 衍生出来的新 tab 也是我们造成的，登记成 owned，
      // 收尾时才关得掉；同时把 curr 指过去，否则 connect() 会挑回旧的 owned tab。
      if (isAttach()) { ownTab(fresh.id); const t = tabs(); t.curr = fresh.id; saveTabs(); }
      // 换连接：旧 cdp 绑在旧 page target 上，不换就永远对着旧页面说话
      try { GWS && GWS.close(); } catch { /* ignore */ }
      ACTIVE_CDP = (await connect()).cdp;
      await waitStable(ACTIVE_CDP);
      await ensureAv(ACTIVE_CDP);
      const am = flags.map ? await capabilityMap(ACTIVE_CDP) : null;
      if (flags.json) return emit(JSON.stringify({ act: res, settle: JSON.parse(settled), new_tab: fresh.url, ...(am ? { after_map: am } : {}) }, null, 2));
      emit(`act → ${JSON.stringify(res)}  ${clicked ? '[' + clicked + ']' : ''}`);
      emit(`# 新标签页 → ${fresh.url}`);
      emit('# 已切到新标签页，下一条命令对它生效');
      if (am) emit('# after-map → ' + JSON.stringify({ site: am.site, title: am.title, total_nodes: am.total_nodes, capabilities: am.capabilities.map(x => ({ use: x.use, count: x.count })) }));
      return;
    }
    // 跳转后要等新页面长稳，否则拿到的是骨架（GitHub 仓库页首屏只有 40 个节点、没有 README）。
    if (JSON.parse(settled).reason === 'navigated') await waitStable(cdp);
    await ensureAv(cdp);
    const stats = await evalJs(cdp, 'window.__av.stats', false);
    const am = flags.map ? await capabilityMap(cdp) : null;
    if (flags.json) return emit(JSON.stringify({ act: res, settle: JSON.parse(settled), stats, ...(am ? { after_map: am } : {}) }, null, 2));
    emit(`act → ${JSON.stringify(res)}`);
    emit(`settle → ${settled}`);
    emit(`# ${human(stats)}`);
    if (am) emit('# after-map → ' + JSON.stringify({ site: am.site, title: am.title, total_nodes: am.total_nodes, capabilities: am.capabilities.map(x => ({ use: x.use, count: x.count })) }));
    return;
  }

  // ── v8: 登录闭环 ──────────────────────────────────────────────────────
  if (cmd === 'login-check') {
    const r = await loginProbe(cdp);
    r.browser = browserLabel();
    r.tab = isAttach() ? tabs().curr : CURR;
    if (flags.shot) {
      const out = typeof flags.shot === 'string' ? flags.shot : 'agentviews/login.png';
      try {
        const s = await cdp.send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(out, Buffer.from(s.data, 'base64'));
        r.shot = out;
      } catch (e) { r.shot_error = e.message; }
    }
    r.advice = r.need_login
      ? '需要登录：请在 ' + browserLabel() + ' 里自己开的那个标签页完成登录，然后继续；或用 login-wait 阻塞等待'
      : '未检测到登录要求，可继续任务';
    emit(JSON.stringify(r, null, 2));
    return;
  }

  if (cmd === 'login-wait' || cmd === 'login-watch') {
    // v9 事件驱动：页面里装活动探针，只有「用户操作 / DOM 或 URL 变化」时才跑
    // 一次登录判定；长时间没有用户操作就休眠（低频心跳），检测到操作立刻激活。
    // 这就是 attach 长连接该有的样子：不轮询空转，但一直连着、一直能感知。
    const sec = Math.max(5, Math.min(1800, Number(flags.timeout) || (cmd === 'login-watch' ? 300 : 90)));
    const idleSec = Math.max(2, Math.min(300, Number(flags.idle) || 12));
    const beatSec = Math.max(1, Math.min(60, Number(flags.beat) || 5));
    const r = await watchLogin(cdp, { timeoutSec: sec, idleSec, beatSec, freeze: !!flags.freeze });
    r.browser = browserLabel();
    r.tab = isAttach() ? tabs().curr : CURR;
    emit(JSON.stringify(r, null, 2));
    return;
  }

  if (cmd === 'shot') {
    // 需要人看的时刻（扫码登录、验证码）就截一张：agent 读 IR，人读图。
    const out = positional[0] || 'shot.png';
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(out, Buffer.from(r.data, 'base64'));
    emit(out);
    return;
  }

  if (cmd === 'verify') {
    const out = await evalJs(cdp, `JSON.stringify({
      url: location.href,
      selected: [...document.querySelectorAll('.selected,[aria-selected="true"],[aria-checked="true"],[aria-expanded="true"]')].map(e=>(e.textContent||'').trim().slice(0,30)).filter(Boolean).slice(0,8),
      checked: [...document.querySelectorAll('input[type=checkbox]:checked')].length,
      nodes: __av.nodes.length
    })`, false);
    emit(out);
    return;
  }

  if (cmd === 'eval') {
    // 逃生舱：语义视图覆盖不到的地方（自绘组件、特殊事件绑定）用它探查/操作。
    // 它是 agent 兜底用的，不是主路径——主路径仍是 name + effects + verify。
    const js = positional.join(' ');
    if (!js) throw new Error('需要表达式');
    const v = await evalJs(cdp, js, true);
    emit(typeof v === 'string' ? v : JSON.stringify(v));
    return;
  }

  if (cmd === 'audit') {
    emit(await evalJs(cdp, 'JSON.stringify(__av.audit())', false));
    return;
  }

  throw new Error('未知命令: ' + cmd);
}

async function serve() {
  // 常驻模式：浏览器和 CDP 连接都活在这个进程里，命令通过 9334 转发进来。
  // 为什么必须常驻：headless Chrome 是当前进程的子进程，父进程一退，
  // 在受限环境（作业对象/进程树回收）里浏览器会跟着被收走，
  // 下一条命令就只能看到一个 about:blank 的新浏览器。
  // 注意：attach 模式不需要 serve（浏览器是宿主的，不会随本进程退出），
  // 单命令模式就够；serve 保留给 standalone 与「想少几次握手」的场景。
  IN_DAEMON = true;
  // v10：serve 也支持扩展模式（长连接桥跟着 daemon 活，命令共用同一个 BRIDGE）。
  if (flags.ext || process.env.AV_EXT === '1') await enableExt();
  else if (flags.auto || process.env.AV_AUTO === '1') await autoAttach();
  // attach 模式不预先 connect()：预连接会在 daemon 启动时立刻 newOwnedTab()
  // 造一个空白标签页，空闲自动退出时又没人收它，就漏一个孤儿 tab 在用户
  // 主浏览器里。改成每条命令自己 connect（ACTIVE_CDP=null，main 里 cdpIn
  // 为空时会走 (await connect()).cdp），空闲退出后不留任何痕迹。
  resolveAttach();
  ACTIVE_CDP = isAttach() ? null : (await connect()).cdp;
  // 空闲自动退出：任务做完忘了 stop，也不该留一个后台进程一直占着。
  // AV_IDLE_MS=0 表示不自动退（调试用）；默认 120000。
  const idleMs = process.env.AV_IDLE_MS === '0' ? 0 : (Number(process.env.AV_IDLE_MS) || 120000);
  let idleTimer = null;
  const touch = () => {
    if (!idleMs) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      dbg('idle timeout, auto exit');
      shutdown(0);
    }, idleMs);
  };
  const server = createServer(async (req, res) => {
    touch();
    if (req.method !== 'POST') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, msg: 'agentviews daemon' }));
    }
    let body = '';
    for await (const c of req) body += c;
    let reply;
    try {
      const { argv } = JSON.parse(body || '{}');
      ({ cmd, flags, positional } = parse(argv || []));
      // v13：--tab / tab use|new 会改 curr；缓存的 ACTIVE_CDP 绑在旧 target 上，
      // 切了 tab 就必须换连接，否则命令还对着旧页面执行。
      await applyTabSelection().catch(() => {});
      const want = (() => { try { return tabs().curr || CURR; } catch { return CURR; } })();
      if (ACTIVE_CDP && ACTIVE_CDP.__tabId && want && ACTIVE_CDP.__tabId !== want) {
        dbg('tab switch reconnect', ACTIVE_CDP.__tabId, '->', want);
        try { GWS && GWS.close(); } catch { /* ignore */ }
        ACTIVE_CDP = (await connect()).cdp;
      }
      await main(ACTIVE_CDP);
      // 命令本身也可能改 curr（tab use/new、act 新标签页）：校准缓存连接。
      try {
        const now = tabs().curr || CURR;
        if (ACTIVE_CDP && ACTIVE_CDP.__tabId && now && ACTIVE_CDP.__tabId !== now) {
          try { GWS && GWS.close(); } catch { /* ignore */ }
          ACTIVE_CDP = (await connect()).cdp;
        }
      } catch { /* ignore */ }
      reply = { ok: true, out: OUT };
    } catch (e) {
      reply = { ok: false, error: e.message };
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(reply));
    // 收尾命令回包之后立刻结束进程（不等 idle 计时）。
    if (SHUTTING) shutdown(0);
  });
  DAEMON_SERVER = server;
  await new Promise(r => server.listen(DAEMON, '127.0.0.1', r));
  console.error(`[av] daemon on 127.0.0.1:${DAEMON} (pid ${process.pid})${idleMs ? ` idle=${idleMs}ms` : ''}`);
  touch();
  await new Promise(() => {}); // shutdown() 里 process.exit 会结束它
}

async function daemonCall(argv) {
  const r = await fetch(`http://127.0.0.1:${DAEMON}/cmd`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ argv }),
  });
  return r.json();
}

if (cmd === 'serve') {
  serve().catch(e => { console.error('ERR', e.message); try { BRIDGE && BRIDGE.close(); } catch {} process.exit(1); });
} else {
  (async () => {
    // 有常驻进程就转发过去；没有就自己干（单命令模式，浏览器随进程结束）。
    // attach 模式一律本地执行：绝不把 --attach 命令转发给可能存在的 standalone
    // daemon（那个 daemon 连的是 9333 的另一套浏览器，会开错 tab / 关错窗口）。
    // v1.0.1：boot 一律本地执行——转发给 standalone daemon 会让浏览器变成
    // daemon 的子进程，且 daemon 可能正连着另一套独立 profile。
    const attachMode = !!(cmd === 'boot' || flags.attach || flags.auto || flags.ext || process.env.AV_AUTO === '1' || process.env.AV_EXT === '1' || process.env.AV_ATTACH_PORT);
    let forwarded = false;
    try {
      if (attachMode) throw new Error('attach: local only');
      const r = await daemonCall(argv0);
      if (r) {
        forwarded = true;
        if (r.ok) { if (r.out.length) console.log(r.out.join('\n')); }
        else { console.error('ERR', r.error); process.exitCode = 1; }
      }
    } catch { /* 没有 daemon，走单命令模式 */ }
    if (forwarded) { await sleep(50); process.exit(process.exitCode || 0); }
    await main();
    if (OUT.length) console.log(OUT.join('\n'));
    try { GWS && GWS.close(); } catch { /* ignore */ }
    try { BRIDGE && BRIDGE.close(); } catch { /* ignore */ }
    await sleep(80);
    process.exit(0);
  })().catch(async e => {
    console.error('ERR', e.message);
    // 全局错误出口：同样要先关 WS 再退，否则挂在 closing 句柄上触发
    // "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" 让进程僵死。
    try { GWS && GWS.close(); } catch { /* ignore */ }
    try { BRIDGE && BRIDGE.close(); } catch { /* ignore */ }
    await sleep(120);
    process.exit(1);
  });
}
