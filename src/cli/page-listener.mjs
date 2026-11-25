import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT_DIRECTORY } from '../core/paths.mjs';
import { acquireSessionLock } from '../core/session-lock.mjs';
import { PageWatchStore, checkPageWatchTarget, isPageWatchActive, recordPageWatch, stopPageWatch } from '../core/page-watch.mjs';

const statePath = resolve(process.argv[2]);
const watchId = process.argv[3];
const store = new PageWatchStore(statePath);
let cancelled = false;
let timer;
let wake;
let activeChild;
const cancel = () => { cancelled = true; clearTimeout(timer); wake?.(); activeChild?.kill('SIGTERM'); };
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);

async function update(operation) {
  const release = await acquireSessionLock(store.filename);
  try {
    const record = store.read();
    if (!record || record.id !== watchId || !isPageWatchActive(record) || record.pid !== null && record.pid !== process.pid) return null;
    operation(record);
    store.save(record);
    return record;
  } finally { release(); }
}

async function observe(record) {
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    if (!checkPageWatchTarget(record, state)) return null;
    const stdout = await new Promise((resolve, reject) => {
      let result;
      const child = execFile(process.execPath, [join(ROOT_DIRECTORY, 'agentviews.mjs'), '--ext', '--state', statePath,
        '--watch-id', watchId, 'observe', '--full', '--json'], { timeout: 180000, maxBuffer: 4 << 20 },
      (error, stdout, stderr) => { result = { error, stdout, stderr }; });
      activeChild = child;
      const cancellation = setInterval(() => {
        try {
          const latest = store.read();
          if (cancelled || !latest || latest.id !== watchId || latest.pid !== process.pid || !isPageWatchActive(latest)) child.kill('SIGTERM');
        } catch { child.kill('SIGTERM'); }
      }, 100);
      child.once('close', () => {
        clearInterval(cancellation); activeChild = null;
        if (result?.error) { result.error.stderr = result.stderr; reject(result.error); }
        else if (result) resolve(result.stdout);
        else reject(new Error('Read process closed without an outcome'));
      });
      if (cancelled) child.kill('SIGTERM');
    });
    const snapshot = JSON.parse(stdout);
    if (snapshot.watch_target_lost) stopPageWatch(record, 'target_lost');
    const fresh = JSON.parse(readFileSync(statePath, 'utf8'));
    if (!checkPageWatchTarget(record, fresh)) return null;
    return snapshot;
  } catch (error) {
    if (/浏览器会话已经改变|浏览器会话已改变/.test(error.stderr || '')) stopPageWatch(record, 'session_changed');
    return null;
  }
}

try {
  const claim = await update(record => { record.pid = process.pid; record.updatedAt = Date.now(); });
  if (claim) {
    while (!cancelled) {
      const record = store.read();
      if (!record || record.id !== watchId || record.pid !== process.pid || !isPageWatchActive(record)) break;
      const snapshot = await observe(record);
      const latest = await update(current => {
        if (!isPageWatchActive(record)) stopPageWatch(current, record.status);
        else if (cancelled) stopPageWatch(current);
        else recordPageWatch(current, snapshot);
      });
      if (!latest || !isPageWatchActive(latest)) break;
      await new Promise(resolve => { wake = resolve; timer = setTimeout(resolve, Math.min(latest.intervalMs, Math.max(0, latest.deadline - Date.now()))); });
      wake = null; clearTimeout(timer);
    }
  }
} finally {
  clearTimeout(timer);
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
  if (cancelled) await update(record => stopPageWatch(record));
}
