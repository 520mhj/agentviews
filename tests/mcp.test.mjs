import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('MCP exposes current-tab and human-resume workflows without browser access', async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../mcp.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; });
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'av_resume', arguments: { user_done: false } } },
  ];
  child.stdin.end(requests.map(request => JSON.stringify(request)).join('\n') + '\n');
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('MCP exit ' + code))); });
  const replies = output.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(replies.length, 3);
  assert.match(replies[0].result.instructions, /付款.*默认不执行/);
  const action = replies[1].result.tools.find(tool => tool.name === 'av_act');
  assert.equal(action.inputSchema.properties.confirm.type, 'string');
  assert.equal(action.inputSchema.properties.user_confirmed.type, 'boolean');
  assert.ok(replies[1].result.tools.some(tool => tool.name === 'av_current'));
  assert.ok(replies[1].result.tools.some(tool => tool.name === 'av_resume'));
  assert.ok(replies[1].result.tools.some(tool => tool.name === 'av_task'));
  assert.ok(replies[1].result.tools.some(tool => tool.name === 'av_watch'));
  assert.equal(replies[2].result.isError, true);
});

test('MCP treats structured failures as errors even when the CLI exits successfully', () => {
  const source = readFileSync(new URL('../src/mcp/server.mjs', import.meta.url), 'utf8');
  const parser = source.slice(source.indexOf('function cliResult('), source.indexOf('function callCli('));
  const parse = runInNewContext(parser + '\ncliResult');
  for (const status of ['needs_user_action', 'needs_agent_review', 'task_skipped']) {
    const result = parse(JSON.stringify({ ok: false, status }));
    assert.equal(result.ok, false);
    assert.equal(result.structured.status, status);
  }
  assert.equal(parse(JSON.stringify({ ok: true, status: 'requires_verification' })).ok, true);
  assert.equal(parse('semantic view text').ok, true);
  assert.equal(parse(JSON.stringify({ ok: false, description: 'page data' }), 'eval').ok, true);
});

test('malformed MCP input does not terminate subsequent requests', async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../mcp.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { output += chunk; });
  child.stdin.end('null\n' + JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/list' }) + '\n');
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('MCP exit ' + code))); });
  const replies = output.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(replies[0].error.code, -32600);
  assert.ok(replies[1].result.tools.some(tool => tool.name === 'av_observe'));
  assert.ok(replies[1].result.tools.some(tool => tool.name === 'av_read'));
});
