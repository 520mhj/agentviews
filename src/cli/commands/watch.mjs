import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { ROOT_DIRECTORY } from '../../core/paths.mjs';
import { acquireSessionLock } from '../../core/session-lock.mjs';
import { PageWatchStore, createPageWatch, isPageWatchActive, pageWatchSummary, pollPageWatch, stopPageWatch } from '../../core/page-watch.mjs';

const execute = promisify(execFile);

export function createWatchCommands({ flags, positional, emit, tabs, listPages, stateFile, isExt, sleep }) {
  return {
    watch: async () => {
      const operation = positional[0] || 'status';
      if (!['start', 'resume', 'status', 'poll', 'stop'].includes(operation)) throw new Error('watch supports start/resume/status/poll/stop');
      const path = resolve(stateFile());
      const store = new PageWatchStore(path);
      if (operation === 'poll') {
        const duration = flags.timeout === undefined ? 0 : Number(flags.timeout);
        if (!Number.isFinite(duration) || duration < 0 || duration > 30) throw new Error('Poll window must be 0–30 seconds');
        const until = Date.now() + duration * 1000;
        let result;
        do {
          result = pollPageWatch(store.read(), { after: Number(flags.after || 0), id: flags['watch-id'] });
          if (result.events.length || !result.watch.active || Date.now() >= until) break;
          await sleep(Math.min(250, Math.max(0, until - Date.now())));
        } while (true);
        if (flags.snapshot) {
          const record = store.read();
          if (!record || record.id !== result.watch.id || record.tab !== result.watch.tab) throw new Error('Watch changed while polling; inspect its identity before reading a snapshot');
          const { stdout } = await execute(process.execPath, [join(ROOT_DIRECTORY, 'agentviews.mjs'), '--ext', '--state', path,
            '--watch-id', record.id, 'observe', '--json'], { timeout: 40000, maxBuffer: 4 << 20 });
          result.snapshot = JSON.parse(stdout);
          if (store.read()?.id !== record.id) throw new Error('Watch changed during the snapshot read; do not mix contexts');
        }
        emit(JSON.stringify({ ...result, state_path: path }, null, 2)); return;
      }
      if (operation === 'status') {
        emit(JSON.stringify({ ok: true, watch: pageWatchSummary(store.read()), state_path: path }, null, 2)); return;
      }
      const release = await acquireSessionLock(store.filename);
      let record;
      try {
        record = store.read();
        if (operation === 'stop') {
          if (record) { stopPageWatch(record); store.save(record); }
        } else {
          if (!isExt()) throw new Error('Persistent watch requires the extension; it never opens an isolated browser');
          const state = tabs();
          if (!state.curr || state.user_current !== state.curr && !state.owned.includes(state.curr)) throw new Error('Select an authorized target before starting watch');
          if (!(await listPages()).some(page => page.id === state.curr)) throw new Error('Watch target is missing; do not open a replacement');
          const summary = pageWatchSummary(record);
          if (record && (operation === 'resume' || summary.active) && (record.tab !== state.curr || record.session !== state.browser_session || record.key !== state.port)) throw new Error('Watch context changed; stop the previous watch explicitly and start a new authorized context');
          if (operation === 'resume' && !record) throw new Error('No watch to resume');
          if (operation === 'start' && summary.active && !summary.worker_alive) throw new Error('Existing watcher is unavailable; use watch resume to retain its cursor and deadline');
          if (!summary.active || !summary.worker_alive) {
            if (operation === 'resume' && (!isPageWatchActive(record) || Date.now() >= record.deadline)) throw new Error('Stopped or expired watches are not resumed automatically');
            record = operation === 'resume' ? { ...record, status: 'starting', pid: null } : createPageWatch({ tab: state.curr,
              session: state.browser_session, key: state.port, intervalMs: flags.beat === undefined ? 1000 : Number(flags.beat) * 1000,
              timeoutSec: flags.timeout === undefined ? 3600 : Number(flags.timeout) });
            store.save(record);
            const worker = spawn(process.execPath, [join(ROOT_DIRECTORY, 'src/cli/page-listener.mjs'), path, record.id], { detached: true, stdio: 'ignore' });
            await new Promise((resolve, reject) => { worker.once('spawn', resolve); worker.once('error', reject); });
            worker.unref();
          }
        }
      } finally { release(); }
      if (operation !== 'stop') {
        const until = Date.now() + 3000;
        while (Date.now() < until && !store.read()?.pid) await sleep(50);
      }
      record = store.read();
      const summary = pageWatchSummary(record);
      emit(JSON.stringify({ ok: operation === 'stop' || summary.active && summary.worker_alive, watch: summary,
        state_path: path, instruction: 'Read-only observation persists independently of the Agent turn. Poll with the watch id and cursor; re-observe before actions. This does not wake or resume an Agent automatically.' }, null, 2));
    },
  };
}
