import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync, lstatSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

const ACTIVE = new Set(['starting', 'running', 'recovering']);
const STATUSES = new Set([...ACTIVE, 'stopped', 'expired', 'target_lost', 'target_changed', 'session_changed']);
const EVENTS_LIMIT = 128;
const RECORD_FIELDS = new Set(['schema', 'id', 'tab', 'session', 'key', 'intervalMs', 'createdAt', 'updatedAt', 'deadline', 'pid', 'status', 'sequence', 'digest', 'lastObservedAt', 'events']);

export function validatePageWatch(record) {
  if (record === null || record === undefined) return null;
  if (!record || record.schema !== 'avs.page-watch/1' || typeof record.id !== 'string' || !record.id
    || typeof record.tab !== 'string' || !record.tab || typeof record.session !== 'string' || !record.session
    || typeof record.key !== 'string' || !record.key.startsWith('ext:') || !STATUSES.has(record.status)
    || !Number.isFinite(record.deadline) || !Number.isFinite(record.createdAt) || !Number.isFinite(record.updatedAt)
    || !Number.isFinite(record.intervalMs) || record.intervalMs < 250 || record.intervalMs > 10000
    || !Number.isSafeInteger(record.sequence) || record.sequence < 0
    || record.pid !== null && (!Number.isSafeInteger(record.pid) || record.pid <= 0)
    || record.digest !== null && !/^[0-9a-f]{64}$/.test(record.digest)
    || !Array.isArray(record.events) || record.events.length > EVENTS_LIMIT
    || Object.keys(record).some(key => !RECORD_FIELDS.has(key))) throw new Error('Invalid page watch state; do not reset or replace its target');
  let previous = 0;
  for (const event of record.events) {
    if (!event || !Number.isSafeInteger(event.sequence) || event.sequence <= previous || event.sequence > record.sequence
      || !Number.isFinite(event.at) || !['page_changed', 'recovered', 'read_failed', 'stopped', 'expired', 'target_lost', 'target_changed', 'session_changed'].includes(event.type)
      || Object.keys(event).some(key => !['sequence', 'at', 'type'].includes(key))) throw new Error('Invalid watch event journal');
    previous = event.sequence;
  }
  return record;
}

export function isPageWatchActive(record) { return !!record && ACTIVE.has(record.status); }

export function createPageWatch({ tab, session, key, intervalMs = 1000, timeoutSec = 3600, now = Date.now() }) {
  if (!Number.isFinite(timeoutSec) || timeoutSec < 1 || timeoutSec > 28800) throw new Error('Watch duration must be 1–28800 seconds');
  return validatePageWatch({ schema: 'avs.page-watch/1', id: randomUUID(), tab, session, key, intervalMs,
    createdAt: now, updatedAt: now, deadline: now + timeoutSec * 1000, pid: null, status: 'starting',
    sequence: 0, digest: null, lastObservedAt: null, events: [] });
}

function appendEvent(record, type, now) {
  record.sequence++;
  record.events.push({ sequence: record.sequence, at: now, type });
  record.events = record.events.slice(-EVENTS_LIMIT);
  record.updatedAt = now;
}

export function stopPageWatch(record, status = 'stopped', now = Date.now()) {
  if (!STATUSES.has(status) || ACTIVE.has(status)) throw new Error('Invalid watch stop status');
  if (!isPageWatchActive(record)) return record;
  record.status = status;
  appendEvent(record, status, now);
  return record;
}

export function checkPageWatchTarget(record, state, now = Date.now()) {
  if (!isPageWatchActive(record)) return false;
  if (now >= record.deadline) { stopPageWatch(record, 'expired', now); return false; }
  if (state?.port !== record.key || state?.browser_session !== record.session) { stopPageWatch(record, 'session_changed', now); return false; }
  if (state.curr !== record.tab || state.user_current !== record.tab && !state.owned?.includes(record.tab)
    || state.long_task && !['completed', 'cancelled'].includes(state.long_task.status) && state.long_task.tab !== record.tab) {
    stopPageWatch(record, 'target_changed', now); return false;
  }
  return true;
}

export function recordPageWatch(record, snapshot, now = Date.now()) {
  if (!isPageWatchActive(record)) return record;
  if (now >= record.deadline) return stopPageWatch(record, 'expired', now);
  if (!snapshot || typeof snapshot.documentId !== 'string' || typeof snapshot.text !== 'string' || !Array.isArray(snapshot.nodes)) {
    if (record.status !== 'recovering') appendEvent(record, 'read_failed', now);
    record.status = 'recovering'; record.updatedAt = now;
    return record;
  }
  const digest = createHash('sha256').update(JSON.stringify({ documentId: snapshot.documentId, url: snapshot.url, text: snapshot.text,
    text_truncated: snapshot.text_truncated, text_total_length: snapshot.text_total_length,
    nodes: snapshot.nodes.map(({ role, name, section, states, checked, selected, value, value_truncated, value_length, options, optionsTotal,
      actions, selectionEvidence, editor_capability }) =>
      ({ role, name, section, states, checked, selected, value, value_truncated, value_length, options, optionsTotal, actions, selectionEvidence, editor_capability })),
    dialogs: snapshot.dialogs, frames: snapshot.frames, frames_total: snapshot.frames_total, frames_truncated: snapshot.frames_truncated })).digest('hex');
  if (record.status === 'recovering') appendEvent(record, 'recovered', now);
  if (digest !== record.digest) { appendEvent(record, 'page_changed', now); record.digest = digest; }
  record.status = 'running'; record.lastObservedAt = now; record.updatedAt = now;
  return record;
}

export function pageWatchSummary(record, now = Date.now()) {
  if (!record) return { status: 'no_watch', active: false };
  let workerAlive = false;
  if (isPageWatchActive(record) && record.pid && now - record.updatedAt <= 185000 + record.intervalMs) {
    try { process.kill(record.pid, 0); workerAlive = true; } catch {}
  }
  return { id: record.id, tab: record.tab, status: record.status, active: isPageWatchActive(record) && now < record.deadline,
    worker_alive: workerAlive, pid: record.pid, remaining_ms: Math.max(0, record.deadline - now),
    last_observed_at: record.lastObservedAt, updated_at: record.updatedAt, cursor: record.sequence,
    read_only: true, page_content_persisted: false, automatic_agent_resume: false };
}

export function pollPageWatch(record, { after = 0, id } = {}) {
  if (!Number.isSafeInteger(after) || after < 0) throw new Error('Watch cursor must be a non-negative integer');
  if (!record) return { ok: true, watch: pageWatchSummary(null), events: [], next_cursor: 0, gap: false };
  if (id && id !== record.id || after > record.sequence) throw new Error('Watch identity or cursor changed; inspect status before resuming');
  return { ok: true, watch: pageWatchSummary(record), events: record.events.filter(event => event.sequence > after),
    next_cursor: record.sequence, gap: record.events.length > 0 && after < record.events[0].sequence - 1 };
}

export class PageWatchStore {
  constructor(statePath) { this.filename = statePath + '.watch.json'; }
  read() {
    try {
      const entry = lstatSync(this.filename);
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Unsafe page watch state path');
      return validatePageWatch(JSON.parse(readFileSync(this.filename, 'utf8')));
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  save(record) {
    validatePageWatch(record);
    mkdirSync(dirname(this.filename), { recursive: true });
    const temporary = this.filename + '.' + randomUUID() + '.tmp';
    try {
      writeFileSync(temporary, JSON.stringify(record, null, 2), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.filename);
    } finally { try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
}
