#!/usr/bin/env node
/**
 * agentview MCP server（stdio，换行分隔的 JSON-RPC 2.0）。
 *
 * 为什么要有这一层：CLI 是给人手敲的，Agent 要的是工具。有了 MCP，
 * Claude Code / Codex / 任何 MCP 客户端把下面这条命令写进配置就能用：
 *
 *   { "mcpServers": { "agentview": { "command": "node",
 *       "args": ["<绝对路径>/agentview/mcp.mjs"] } } }
 *
 * 它把每个 tool call 转发给 `agentview.mjs`（有 daemon 走 daemon，
 * 没有就走单命令模式），所以不需要重复实现一套 CDP 逻辑。
 */
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'agentview.mjs');

const TOOLS = [
  {
    name: 'av_open',
    description: '打开网页并返回它的语义视图（节点 id/role/name/effects/preconditions）。后续操作用 av_act，验证用 av_verify。',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: '要打开的完整 URL' } },
      required: ['url'],
    },
  },
  {
    name: 'av_view',
    description: '重新采样当前页面的语义视图。页面自己变了（轮播、异步加载）之后用它刷新，不用重新 open。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'av_find',
    description: '按名字子串查节点，返回 id / handle / effects / preconditions。名字不确定时先查再点，比盲点省一次失败。',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: '名字里的子串' } },
      required: ['query'],
    },
  },
  {
    name: 'av_act',
    description: '操作一个节点：按名字（推荐，页面重建后仍有效）或 id 点击；给 text 则填值。返回动作是否成功、DOM 安静耗时。名字有歧义时会返回 AMBIGUOUS_NAME 和候选，不要重试同一个名字，改成更精确的。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '节点名字（可子串，完全匹配优先）' },
        id: { type: 'string', description: '节点 id（如 n28），页面未重建时可用' },
        text: { type: 'string', description: '填值内容；省略则为点击' },
      },
    },
  },
  {
    name: 'av_verify',
    description: '读当前页面可验证的状态：URL、选中项、勾选数、节点数。用它做断言，别靠"看起来变了"。',
    inputSchema: { type: 'object', properties: {} },
  },
];

function callCli(args, timeout = 120000) {
  return new Promise(resolve => {
    execFile(process.execPath, [CLI, ...args], { cwd: HERE, maxBuffer: 8 << 20, timeout },
      (err, stdout, stderr) => {
        resolve(err ? { ok: false, text: (stderr || err.message || '').trim() || '命令失败' } : { ok: true, text: stdout.trim() });
      });
  });
}

async function callTool(name, a = {}) {
  switch (name) {
    case 'av_open':
      if (!a.url) return { ok: false, text: '缺少 url' };
      return callCli(['open', a.url]);
    case 'av_view':
      return callCli(['view']);
    case 'av_find':
      return callCli(['find', a.query || '']);
    case 'av_act': {
      const args = ['act'];
      if (a.name) args.push('--name', a.name);
      else if (a.id) args.push('--id', a.id);
      else return { ok: false, text: '需要 name 或 id' };
      if (a.text !== undefined) args.push('--text', String(a.text));
      return callCli(args);
    }
    case 'av_verify':
      return callCli(['verify']);
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
          serverInfo: { name: 'agentviews', version: '0.8.0' },
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
