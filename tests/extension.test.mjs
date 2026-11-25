import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { webcrypto } from 'node:crypto';

function worker({ debuggerApi = {}, schedule = setTimeout, clock = Date } = {}) {
  const storage = {};
  const tabs = new Map([[1, { id: 1, active: true, url: 'https://example.com', title: 'User page' }]]);
  const events = [];
  let calls = 0;
  const chrome = {
    runtime: { id: 'test', getManifest: () => ({ version: '1.0.0' }) },
    storage: {
      onChanged: { addListener: () => {} },
      local: { get: () => {}, onChanged: { addListener: () => {} } },
      session: {
        get: async defaults => ({ ...defaults, ...storage }),
        set: async value => Object.assign(storage, value),
      },
    },
    alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
    tabs: {
      query: async query => [...tabs.values()].filter(tab => !query.active || tab.active),
      create: async details => { events.push(details); const tab = { id: 2, ...details }; tabs.set(2, tab); return tab; },
      update: async (tabId, details) => { Object.assign(tabs.get(tabId), details); return tabs.get(tabId); },
      remove: async tabId => tabs.delete(tabId),
      onRemoved: { addListener: () => {} },
    },
    debugger: {
      attach: async () => {},
      detach: async () => {},
      onDetach: { addListener: () => {} },
      ...debuggerApi,
      sendCommand: async (...args) => {
        calls++;
        if (debuggerApi.sendCommand) return debuggerApi.sendCommand(...args);
        throw new Error('network failure after dispatch');
      },
    },
  };
  const context = createContext({ chrome, navigator: { userAgent: 'test' }, setTimeout: schedule, clearTimeout, Date: clock, crypto: webcrypto });
  runInContext(readFileSync(new URL('../bridge-ext/sw.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, ''), context);
  return { run: (operation, args = {}, expiresAt = Infinity) => runInContext('run(' + JSON.stringify(operation) + ',' + JSON.stringify(args) + ',' + expiresAt + ')', context), tabs, events, storage, calls: () => calls };
}

test('extension creates background tabs and only closes its own tabs', async () => {
  const extension = worker();
  await assert.rejects(extension.run('tabs.close', { tabId: '1' }), /拒绝关闭用户/);
  const created = await extension.run('tabs.create', { url: 'https://example.com' });
  assert.equal(created.id, '2');
  assert.equal(extension.events[0].active, false);
  assert.equal(extension.tabs.get(2).muted, true);
  await extension.run('tabs.close', { tabId: '2' });
  assert.equal(extension.tabs.has(1), true);
  assert.equal(extension.tabs.has(2), false);
});

test('current-tab selection works without activation and preserves user ownership', async () => {
  const extension = worker();
  assert.equal((await extension.run('tabs.current')).id, '1');
  assert.equal(extension.events.length, 0);
  assert.equal(extension.tabs.get(1).muted, undefined);
  await assert.rejects(extension.run('tabs.close', { tabId: '1' }), /拒绝关闭用户/);
});

test('a failed dispatched browser action is never automatically replayed', async () => {
  const extension = worker();
  await assert.rejects(extension.run('debugger.send', { tabId: '1', method: 'Input.dispatchMouseEvent', params: {} }));
  assert.equal(extension.calls(), 1);
});

test('tabs retained for the user cannot be closed by a later task', async () => {
  const extension = worker();
  await extension.run('tabs.create', { url: 'https://example.com' });
  await extension.run('tabs.preserve', { tabIds: ['2'] });
  await assert.rejects(extension.run('tabs.close', { tabId: '2' }), /拒绝关闭用户/);
  assert.equal(extension.tabs.has(2), true);
});

test('scoped debugger cleanup leaves other task attachments intact', async () => {
  const extension = worker();
  for (const tabId of ['1', '2']) await assert.rejects(extension.run('debugger.send', { tabId, method: 'Runtime.enable' }));
  assert.equal((await extension.run('debugger.detachAll', { tabIds: ['1'] })).detached, 1);
  assert.deepEqual(Array.from((await extension.run('ping')).attached), ['2']);
  await assert.rejects(extension.run('debugger.detachAll', { tabIds: ['invalid'] }), /invalid/);
  assert.deepEqual(Array.from((await extension.run('ping')).attached), ['2']);
});

test('the extension rechecks a job deadline after attaching before writing', async () => {
  let now = Date.now();
  const expiresAt = now + 1000;
  const extension = worker({ clock: { now: () => now }, debuggerApi: {
    attach: async () => { now = expiresAt + 1; },
    sendCommand: async () => ({}),
  } });
  await assert.rejects(extension.run('debugger.send', { tabId: '1', method: 'Input.dispatchMouseEvent', params: {} }, expiresAt), /expired before command dispatch/);
  assert.equal(extension.calls(), 0);
  await extension.run('debugger.detachAll', { tabIds: ['1'] });
});

test('a timed-out attachment stays uncertain until its late success is detached', async () => {
  let completeAttach;
  let attached = false;
  let detachCalls = 0;
  const extension = worker({ schedule: (callback, milliseconds) => setTimeout(callback, milliseconds === 20000 ? 5 : milliseconds), debuggerApi: {
    attach: () => new Promise(resolve => { completeAttach = () => { attached = true; resolve(); }; }),
    detach: async () => { detachCalls++; attached = false; },
  } });
  await assert.rejects(extension.run('debugger.send', { tabId: '1', method: 'Input.dispatchMouseEvent', params: {} }), /timed out/);
  await assert.rejects(extension.run('debugger.detachAll', { tabIds: ['1'] }), /cleanup incomplete/);
  assert.equal(detachCalls, 0);
  assert.deepEqual(Array.from(extension.storage.avUncertainTabs), ['1']);
  completeAttach();
  await new Promise(resolve => setTimeout(resolve, 0));
  const state = await extension.run('ping');
  assert.equal(attached, false);
  assert.equal(detachCalls, 1);
  assert.deepEqual(Array.from(state.attached), []);
  assert.deepEqual(Array.from(state.uncertain_tabs), []);
  assert.equal(extension.calls(), 0);
});

test('failed late attachment cleanup retains uncertainty for explicit recovery', async () => {
  let completeAttach;
  let failCleanup = true;
  const extension = worker({ schedule: (callback, milliseconds) => setTimeout(callback, milliseconds === 20000 ? 5 : milliseconds), debuggerApi: {
    attach: () => new Promise(resolve => { completeAttach = resolve; }),
    detach: async () => { if (failCleanup) throw new Error('cleanup failed'); },
  } });
  await assert.rejects(extension.run('debugger.send', { tabId: '1', method: 'Input.dispatchKeyEvent', params: {} }), /timed out/);
  completeAttach();
  await new Promise(resolve => setTimeout(resolve, 0));
  const before = await extension.run('ping');
  assert.deepEqual(Array.from(before.attached), ['1']);
  assert.deepEqual(Array.from(before.uncertain_tabs), ['1']);
  await assert.rejects(extension.run('tabs.list'), /unknown outcome/);
  failCleanup = false;
  await extension.run('debugger.detachAll', { tabIds: ['1'] });
  assert.deepEqual(Array.from((await extension.run('ping')).uncertain_tabs), []);
  assert.equal(extension.calls(), 0);
});

test('cleanup cannot erase uncertainty while an earlier detach remains pending', async () => {
  let completeDetach;
  let detachCalls = 0;
  const extension = worker({ schedule: (callback, milliseconds) => setTimeout(callback, milliseconds === 3000 ? 5 : milliseconds), debuggerApi: {
    detach: () => { detachCalls++; return new Promise(resolve => { completeDetach = resolve; }); },
  } });
  await assert.rejects(extension.run('debugger.send', { tabId: '1', method: 'Runtime.enable' }), /network failure/);
  await assert.rejects(extension.run('debugger.detachAll', { tabIds: ['1'] }), /cleanup incomplete/);
  await assert.rejects(extension.run('debugger.detachAll', { tabIds: ['1'] }), /cleanup incomplete/);
  assert.equal(detachCalls, 1);
  assert.deepEqual(Array.from(extension.storage.avUncertainTabs), ['1']);
  await assert.rejects(extension.run('debugger.send', { tabId: '1', method: 'Input.dispatchKeyEvent' }), /unknown outcome/);
  completeDetach();
  await new Promise(resolve => setTimeout(resolve, 0));
  const state = await extension.run('ping');
  assert.deepEqual(Array.from(state.attached), []);
  assert.deepEqual(Array.from(state.uncertain_tabs), []);
  assert.equal(detachCalls, 1);
});
