import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { validateLongTask } from './long-task.mjs';

export class TaskState {
  constructor({ path, key }) { this.path = path; this.key = key; }

  reload() {
    this.filename = null;
    this.current = null;
    return this.get();
  }

  get() {
    const filename = this.path(), key = this.key();
    if (this.filename === filename && this.current?.port === key) return this.current;
    let stored = {};
    try { stored = JSON.parse(readFileSync(filename, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('安全任务状态不可读：' + error.message); }
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw new Error('无效任务状态');
    if (stored.port !== key) stored = {};
    const ids = value => Array.isArray(value) ? [...new Set(value.filter(id => typeof id === 'string'))] : [];
    if (stored.pending_user_action && typeof stored.pending_user_action !== 'object') throw new Error('无效人工接管状态');
    if (stored.action_confirmation && (typeof stored.action_confirmation !== 'object' || Array.isArray(stored.action_confirmation)
      || stored.action_confirmation.request_id !== stored.pending_user_action?.confirmation?.request_id)) throw new Error('无效操作确认状态');
    this.filename = filename;
    this.current = { port: key, baseline_set: !!stored.baseline_set, baseline: ids(stored.baseline), owned: ids(stored.owned),
      preserved: ids(stored.preserved), curr: stored.curr || null, user_current: stored.user_current || null,
      pending_user_action: stored.pending_user_action || null, browser_session: stored.browser_session || null,
      action_confirmation: stored.action_confirmation || null,
      long_task: validateLongTask(stored.long_task) };
    return this.current;
  }

  save() {
    const state = this.get();
    mkdirSync(dirname(this.filename), { recursive: true });
    const temporary = this.filename + '.' + process.pid + '.tmp';
    writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(temporary, this.filename);
  }
}
