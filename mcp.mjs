#!/usr/bin/env node
/**
 * agentviews MCP server（stdio，换行分隔的 JSON-RPC 2.0）。
 *
 * 为什么要有这一层：CLI 是给人手敲的，Agent 要的是工具。有了 MCP，
 * Claude Code / Codex / 豆包 / 任何 MCP 客户端把下面这条命令写进配置就能用：
 *
 *   { "mcpServers": { "agentviews": { "command": "node",
 *       "args": ["<绝对路径>/agentviews/mcp.mjs"] } } }
 *
 * 它把每个 tool call 转发给 `agentview.mjs`（有 daemon 走 daemon，
 * 没有就走单命令模式），所以不需要重复实现一套 CDP 逻辑。
 *
 * 传输方式跟 CLI 一致：环境变量 AGENTVIEWS_TRANSPORT=ext|auto|attach|standalone
 * 决定用扩展桥还是裸 CDP。默认 ext（复用桌面主浏览器的登录态）。
 */
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'agentview.mjs');

// 传输层前缀：所有命令共用，避免每个 tool 都要传一遍
const TRANSPORT = (process.env.AGENTVIEWS_TRANSPORT || 'ext').toLowerCase();
function tflags() {
  if (TRANSPORT === 'ext') return ['--ext'];
  if (TRANSPORT === 'auto') return ['--auto'];
  if (TRANSPORT === 'standalone') return [];
  if (TRANSPORT.startsWith('attach:')) return ['--attach', TRANSPORT.slice(7)];
  return ['--ext'];
}

const TOOLS = [
  {
    name: 'av_open',
    description:
      '打开一个网址，返回它的语义视图（节点 id / role / name / effects / preconditions）。' +
      '这是所有任务的起点。后续操作一律用 av_act，验证一律用 av_verify。',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: '完整 URL，含 https://' } },
      required: ['url'],
    },
  },
  {
    name: 'av_view',
    description:
      '重新采样当前页面的语义视图。页面自己变了（轮播、异步加载、滚动追加）之后用它刷新，不必重新 open。' +
      '只想看某一块时用 av_find 更省。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'av_map',
    description:
      '能力地图：把当前页一级界面按用途分组（检索 / 导航 / 打开条目 / 账户 / 动作 / 内容），' +
      '每组带条数与 effects。到陌生站点先跑它，比盲点省很多次失败。' +
      'full=true 时返回全部节点（体积大，慎用）。',
    inputSchema: {
      type: 'object',
      properties: { full: { type: 'boolean', description: '返回全量节点而不是每类前 14 个样例' } },
    },
  },
  {
    name: 'av_find',
    description:
      '按名字子串查节点，返回 id / handle / role / effects / preconditions / 是否可点。' +
      '名字不确定时先查再点。返回空说明名字不对，不要硬点。',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: '名字里的子串，越短越容易命中' } },
      required: ['query'],
    },
  },
  {
    name: 'av_act',
    description:
      '操作一个节点：按 name（推荐，页面重建后仍有效）或 id 点击；给 text 则填值。' +
      '返回 ok / resolved / point / settle。' +
      '注意 ok=true 只表示"算出了目标并派发了事件"，是否达成业务目标要自己再读页面确认（av_verify 或 av_view）。' +
      '名字有歧义会返回 AMBIGUOUS_NAME 与候选，换更精确的名字，不要重试同一个。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '节点名字（可子串，完全匹配优先）' },
        id: { type: 'string', description: '节点 id（如 n28）；页面重建后失效' },
        text: { type: 'string', description: '填值内容；省略则为点击' },
      },
    },
  },
  {
    name: 'av_verify',
    description:
      '读当前页面可验证的结构化状态：URL、选中项 selected、勾选数 checked、节点数 nodes。' +
      '用它做断言，别靠"看起来变了"。需要更细的证据用 av_eval 自己写表达式。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'av_search',
    description:
      '站内检索：自动在地图里找搜索框 → 填词 → 提交 → 等结果页稳定 → 返回新页视图。' +
      '全程复用同一个标签页，不新开窗口。找不到搜索框时会退化成导航到 /search?q= 并说明。',
    inputSchema: {
      type: 'object',
      properties: { keyword: { type: 'string', description: '搜索关键词' } },
      required: ['keyword'],
    },
  },
  {
    name: 'av_collect',
    description:
      '结构化采集：边滚边抓（虚拟列表滚过一屏会卸载旧节点，必须逐轮累积去重），' +
      '产出 [{title, href, metrics, metrics_typed, kind}]。' +
      'metrics_typed 里每项带 label（播放/点赞/评论/转发/收藏/弹幕/粉丝/Star/时长/日期/未标注）。' +
      'kind=content_block 表示这是正文块，href 可能为 null（不是每条内容都有独立链接）。',
    inputSchema: {
      type: 'object',
      properties: {
        max: { type: 'number', description: '最多采集条数，默认 200' },
        rounds: { type: 'number', description: '最多滚动轮数，默认 12' },
        json: { type: 'boolean', description: '返回 JSON（默认 true，MCP 场景建议保持）' },
      },
    },
  },
  {
    name: 'av_login_check',
    description:
      '检查当前页是否撞到登录墙：返回 need_login / logged_in / hints / advice。' +
      '需要人工登录时，把 hints 转述给用户，等他在浏览器里登完，再用 av_login_watch 继续。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'av_login_watch',
    description:
      '等用户手动登录：事件驱动（页内监听真人动作），登录完成即返回 login_done；' +
      '超时如实返回 timeout_still_login，不会假装成功。',
    inputSchema: {
      type: 'object',
      properties: {
        timeout: { type: 'number', description: '最长等待秒数，默认 90，上限 1800' },
        idle: { type: 'number', description: '无事件多少秒后进入 dormant，默认 12' },
        freeze: { type: 'boolean', description: 'dormant 时冻结标签页省内存' },
      },
    },
  },
  {
    name: 'av_pages',
    description:
      '列出当前浏览器标签页，并标出哪些是 agentviews 自己开的（mine=true）、哪些是用户的（user=true）。' +
      '收尾前用它确认要关哪些。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'av_done',
    description:
      '任务性收尾：关闭本次任务自己开的标签页，用户的标签页一个不动（baseline 永久保护），' +
      '返回 closed_owned_tabs / user_tabs_untouched。' +
      '如果这次只是辅助操作、用户还要继续用这些页面，改用 av_keep。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'av_keep',
    description:
      '辅助性收尾：什么都不关，把当前标签页与状态反馈回去，让用户接着用。' +
      '做完一件事但页面还有价值时用它，别顺手 av_done 把人家正在看的页面关掉。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'av_eval',
    description:
      '在页面里执行一段 JS 表达式并返回结果（returnByValue）。' +
      '语义视图不够用时用它取任意结构化事实（例如读某个列表的长度、某个 DOM 属性的真实值）。' +
      '写的时候注意它是表达式不是语句块，需要多行就包成 (()=>{...})()。',
    inputSchema: {
      type: 'object',
      properties: { expression: { type: 'string', description: '要在页面上下文求值的 JS 表达式' } },
      required: ['expression'],
    },
  },
  {
    name: 'av_shot',
    description: '截当前页面的图，返回保存路径。语义视图读不出"长什么样"时（Canvas、图表、布局错乱）用它补一眼。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '保存路径，省略则用默认文件名' } },
    },
  },
];

function callCli(args, timeout = 180000) {
  return new Promise(resolve => {
    execFile(process.execPath, [CLI, ...args], { cwd: HERE, maxBuffer: 32 << 20, timeout },
      (err, stdout, stderr) => {
        resolve(err ? { ok: false, text: (stderr || err.message || '').trim() || '命令失败' } : { ok: true, text: stdout.trim() });
      });
  });
}

async function callTool(name, a = {}) {
  const T = tflags();
  switch (name) {
    case 'av_open':
      if (!a.url) return { ok: false, text: '缺少 url' };
      return callCli([...T, 'open', a.url]);
    case 'av_view':
      return callCli([...T, 'view']);
    case 'av_map':
      return callCli([...T, 'map', ...(a.full ? ['--full'] : [])]);
    case 'av_find':
      return callCli([...T, 'find', a.query || '']);
    case 'av_act': {
      const args = [...T, 'act'];
      if (a.name) args.push('--name', a.name);
      else if (a.id) args.push('--id', a.id);
      else return { ok: false, text: '需要 name 或 id' };
      if (a.text !== undefined) args.push('--text', String(a.text));
      return callCli(args);
    }
    case 'av_verify':
      return callCli([...T, 'verify']);
    case 'av_search':
      if (!a.keyword) return { ok: false, text: '缺少 keyword' };
      return callCli([...T, 'search', a.keyword]);
    case 'av_collect': {
      const args = [...T, 'collect', '--json'];
      if (a.max) args.push('--max', String(a.max));
      if (a.rounds) args.push('--rounds', String(a.rounds));
      return callCli(args);
    }
    case 'av_login_check':
      return callCli([...T, 'login-check']);
    case 'av_login_watch': {
      const args = [...T, 'login-watch'];
      if (a.timeout) args.push('--timeout', String(a.timeout));
      if (a.idle) args.push('--idle', String(a.idle));
      if (a.freeze) args.push('--freeze');
      return callCli(args, 1900000);
    }
    case 'av_pages':
      return callCli([...T, 'pages']);
    case 'av_done':
      return callCli([...T, 'done']);
    case 'av_keep':
      return callCli([...T, 'keep']);
    case 'av_eval':
      if (!a.expression) return { ok: false, text: '缺少 expression' };
      return callCli([...T, 'eval', a.expression]);
    case 'av_shot':
      return callCli([...T, 'shot', ...(a.path ? [a.path] : [])]);
    default:
      return { ok: false, text: `未知工具: ${name}` };
  }
}

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', async chunk => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let req;
    try { req = JSON.parse(line); } catch { continue; }
    const { id, method, params } = req;
    try {
      if (method === 'initialize') {
        send({ jsonrpc: '2.0', id, result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'agentviews', version: '0.9.0' },
        } });
      } else if (method === 'tools/list') {
        send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      } else if (method === 'tools/call') {
        const r = await callTool(params?.name, params?.arguments || {});
        send({ jsonrpc: '2.0', id, result: {
          content: [{ type: 'text', text: r.text || '(空)' }],
          isError: !r.ok,
        } });
      } else if (method === 'notifications/initialized' || method === 'initialized') {
        // 通知不需要回
      } else if (id !== undefined) {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `未知方法: ${method}` } });
      }
    } catch (e) {
      if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32000, message: e.message } });
    }
  }
});
