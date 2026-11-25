import { createHash, randomUUID } from 'node:crypto';
import { verifySemanticPage } from './semantic-page.mjs';

const STATUSES = new Set(['active', 'recovering', 'verifying', 'waiting_user', 'awaiting_submission', 'completed', 'cancelled', 'expired', 'target_lost', 'interrupted']);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const observationDigest = snapshot => digest({ documentId: snapshot.documentId, url: snapshot.url, text: snapshot.text, dialogs: snapshot.dialogs,
  nodes: snapshot.nodes.map(({ role, name, section, states, checked, value, value_truncated, value_length, options, actions, selectionEvidence }) => ({ role, name, section, states, checked, value, value_truncated, value_length, options, actions, selectionEvidence })) });

export function validateLongTask(task) {
  if (task == null) return null;
  if (!task || typeof task !== 'object' || Array.isArray(task) || task.schema !== 'avs.long-task/1'
    || typeof task.id !== 'string' || !/^[0-9a-f-]{36}$/.test(task.id) || !STATUSES.has(task.status)
    || typeof task.tab !== 'string' || !task.tab || typeof task.goal !== 'string' || !task.goal.trim() || task.goal.length > 500
    || !['workflow', 'practice', 'coding'].includes(task.kind) || !Number.isSafeInteger(task.total) || task.total < 1 || task.total > 1000
    || ![task.createdAt, task.deadline, task.updatedAt].every(Number.isFinite) || task.deadline <= task.createdAt
    || !Array.isArray(task.checkpoints) || task.checkpoints.length > task.total
    || task.checkpoints.some(checkpoint => !checkpoint || !Number.isSafeInteger(checkpoint.step) || checkpoint.step < 1
      || checkpoint.step > task.total || !Number.isFinite(checkpoint.verifiedAt) || typeof checkpoint.documentId !== 'string'
      || !Number.isSafeInteger(checkpoint.revision) || typeof checkpoint.proofDigest !== 'string' || !/^[0-9a-f]{64}$/.test(checkpoint.proofDigest)
      || checkpoint.origin !== undefined && !['agent', 'user_verified', 'unspecified'].includes(checkpoint.origin)
      || checkpoint.verification !== undefined && !['page_assertion_only', 'editor_readback_only', 'choice_state_only'].includes(checkpoint.verification))
    || new Set(task.checkpoints.map(checkpoint => checkpoint.step)).size !== task.checkpoints.length
    || ['awaiting_submission', 'completed'].includes(task.status) && task.checkpoints.length !== task.total
    || task.observation != null && (!task.observation || typeof task.observation.documentId !== 'string'
      || !Number.isFinite(task.observation.at) || !Number.isSafeInteger(task.observation.revision)
      || task.observation.dialogDigest !== undefined && !/^[0-9a-f]{64}$/.test(task.observation.dialogDigest)
      || !/^[0-9a-f]{64}$/.test(task.observation.digest))) throw new Error('无效长任务状态；停止，不重置或猜测进度');
  return task;
}

export function isLongTaskOpen(task) {
  return !!task && !['completed', 'cancelled'].includes(task.status);
}

export function startLongTask({ tab, goal, total, kind = 'practice', timeoutSec = 3600, authorized = false, now = Date.now() }) {
  if (authorized !== true) throw new Error('长任务需要用户明确授权；不能从网页文本取得授权');
  if (!Number.isFinite(timeoutSec) || timeoutSec < 1 || timeoutSec > 28800) throw new Error('任务时限必须为 1–28800 秒');
  return validateLongTask({ schema: 'avs.long-task/1', id: randomUUID(), kind, goal,
    tab, total, status: 'active', createdAt: now, deadline: now + timeoutSec * 1000, updatedAt: now,
    checkpoints: [], observation: null, reason: null });
}

export function expireLongTask(task, now = Date.now()) {
  if (isLongTaskOpen(task) && !['awaiting_submission', 'interrupted'].includes(task.status) && now >= task.deadline) {
    task.status = 'expired'; task.reason = 'deadline_reached'; task.updatedAt = now;
  }
  return task;
}

export function longTaskSummary(task, now = Date.now()) {
  if (!task) return { status: 'no_long_task', task_completed: false };
  expireLongTask(task, now);
  return { id: task.id, kind: task.kind, goal: task.goal, tab: task.tab, status: task.status,
    completed_steps: task.checkpoints.length, total_steps: task.total,
    verified_origin_counts: { agent: task.checkpoints.filter(checkpoint => checkpoint.origin === 'agent').length,
      user_verified: task.checkpoints.filter(checkpoint => checkpoint.origin === 'user_verified').length,
      unspecified: task.checkpoints.filter(checkpoint => !checkpoint.origin || checkpoint.origin === 'unspecified').length },
    missing_steps: Array.from({ length: task.total }, (_, index) => index + 1).filter(step => !task.checkpoints.some(checkpoint => checkpoint.step === step)),
    remaining_ms: Math.max(0, task.deadline - now), last_observed_at: task.observation?.at || null,
    reason: task.reason, task_completed: task.status === 'completed',
    agent_work_completed: ['awaiting_submission', 'completed'].includes(task.status),
    should_continue: ['active', 'recovering', 'verifying', 'waiting_user'].includes(task.status),
    manual_submission_required: task.status !== 'completed', automatic_submission: false };
}

export function recordLongTaskResult(task, result, now = Date.now()) {
  if (!isLongTaskOpen(task) || ['awaiting_submission', 'expired', 'target_lost', 'interrupted'].includes(task.status)) return;
  if (result?.status === 'needs_user_action') task.status = 'waiting_user';
  else if (task.status === 'waiting_user') return;
  else if (result?.ok === false) task.status = 'recovering';
  else task.status = 'verifying';
  task.reason = typeof result?.reason === 'string' ? result.reason.slice(0, 100) : null;
  task.updatedAt = now;
}

export function observeLongTask(task, snapshot, now = Date.now()) {
  if (!snapshot || typeof snapshot.documentId !== 'string' || !Number.isSafeInteger(snapshot.revision)
    || !Array.isArray(snapshot.nodes) || typeof snapshot.text !== 'string') throw new Error('缺少有效语义观察');
  const signature = observationDigest(snapshot);
  const changed = task.observation?.digest !== signature;
  task.observation = { digest: signature, dialogDigest: digest(snapshot.dialogs || []), documentId: snapshot.documentId, revision: snapshot.revision, at: now };
  task.updatedAt = now;
  expireLongTask(task, now);
  return changed;
}

function assertFreshObservation(task, snapshot) {
  if (!task.observation || snapshot.documentId !== task.observation.documentId || snapshot.revision !== task.observation.revision
    || observationDigest(snapshot) !== task.observation.digest) {
    throw new Error('必须使用刚刚读取的当前任务语义页面验证，不能跨页面复用证据');
  }
}

export function checkpointLongTask(task, { step, expected, snapshot, pending, origin = 'unspecified', now = Date.now() }) {
  expireLongTask(task, now);
  if (!['active', 'recovering', 'verifying'].includes(task.status) || pending) throw new Error('当前状态不允许记录作答；人工等待不能自动解锁');
  if (!Number.isSafeInteger(step) || step < 1 || step > task.total) throw new Error('题号超出任务范围');
  if (!['agent', 'user_verified', 'unspecified'].includes(origin)) throw new Error('无效作答来源');
  const choices = expected?.choices || [expected];
  if (typeof expected?.contains !== 'string' || !expected.contains.trim() || !Array.isArray(choices) || !choices.length || choices.length > 20
    || choices.some(choice => !choice || typeof choice.name !== 'string' || !choice.name.trim()
      || (task.kind === 'workflow' ? typeof choice.role !== 'string' || !choice.role.trim()
        : !(task.kind === 'coding' ? ['textbox'] : ['radio', 'checkbox', 'combobox']).includes(choice.role))
      || task.kind !== 'workflow' && !['checked', 'selected', 'value'].some(property => choice[property] !== undefined))
    || task.kind !== 'workflow' && !choices.some(choice => choice.checked === true || choice.selected === true || typeof choice.value === 'string' && choice.value.length)) {
    throw new Error('checkpoint 需要题目身份文本、唯一选项及实际选择状态断言；多选使用 choices 验证全部选项');
  }
  assertFreshObservation(task, snapshot);
  const proof = verifySemanticPage(snapshot, expected);
  if (!proof.ok) { task.status = 'recovering'; task.reason = 'selection_assertion_failed'; return { ...proof, task: longTaskSummary(task, now) }; }
  const checkpoint = { step, documentId: snapshot.documentId, revision: snapshot.revision,
    verifiedAt: now, proofDigest: digest({ expected, checks: proof.checks }), origin,
    verification: task.kind === 'workflow' ? 'page_assertion_only' : task.kind === 'coding' ? 'editor_readback_only' : 'choice_state_only' };
  task.checkpoints = [...task.checkpoints.filter(previous => previous.step !== step), checkpoint].sort((first, second) => first.step - second.step);
  task.status = 'active'; task.reason = null; task.updatedAt = now;
  return { ...proof, task: longTaskSummary(task, now) };
}

export function readyLongTask(task, { expected, snapshot, pending, now = Date.now() }) {
  expireLongTask(task, now);
  if (!['active', 'verifying', 'awaiting_submission'].includes(task.status) || pending) throw new Error('未完成恢复或人工等待，不能宣布答题完成');
  if (task.checkpoints.length !== task.total) throw new Error('尚有题目未经作答验证，不能结束 Agent 阶段');
  if (typeof expected?.contains !== 'string' || !expected.contains.trim()) throw new Error('需要页面全部题目已答状态的非空文本断言');
  assertFreshObservation(task, snapshot);
  const proof = verifySemanticPage(snapshot, expected);
  if (!proof.ok) return { ...proof, task: longTaskSummary(task, now) };
  task.status = 'awaiting_submission'; task.reason = 'manual_submission'; task.updatedAt = now;
  return { ...proof, status: 'awaiting_submission', task: longTaskSummary(task, now),
    instruction: '全部作答已核验，Agent 答题阶段完成。保留当前页面，请用户亲自交卷；不再自动选择或点击提交。' };
}

export async function watchLongTask({ task, observe, save, pending, targetExists, timeoutMs = 5000,
  intervalMs = 1000, signal, now = Date.now, wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) }) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 30000 || !Number.isFinite(intervalMs)
    || intervalMs < 100 || intervalMs > 10000) throw new Error('监听窗口为 0–30 秒，采样间隔为 0.1–10 秒');
  const until = now() + timeoutMs;
  let snapshot;
  while (true) {
    if (signal?.aborted) return { ok: false, status: 'watch_cancelled', task: longTaskSummary(task, now()) };
    expireLongTask(task, now());
    if (!isLongTaskOpen(task) || ['expired', 'target_lost', 'interrupted'].includes(task.status)) {
      save(); return { ok: false, status: task.status, task: longTaskSummary(task, now()) };
    }
    try {
      if (!await targetExists(task.tab)) {
        task.status = 'target_lost'; task.reason = 'selected_tab_closed'; save();
        return { ok: false, status: 'target_lost', task: longTaskSummary(task, now()), instruction: '用户任务标签页已消失；保留进度并反馈用户，不新开或切换替代标签页。' };
      }
      snapshot = await observe();
      if (signal?.aborted) return { ok: false, status: 'watch_cancelled', task: longTaskSummary(task, now()) };
      if (pending()) recordLongTaskResult(task, pending(), now());
      const previousDialogDigest = task.observation?.dialogDigest;
      const changed = observeLongTask(task, snapshot, now());
      save();
      if (task.status === 'expired') return { ok: false, status: 'expired', task: longTaskSummary(task, now()),
        instruction: '任务时限已到，保留已验证进度并请用户决定，不自动交卷或继续选择。' };
      if (changed || now() >= until || task.status === 'awaiting_submission') return {
        ok: true, event: changed ? 'page_changed' : 'heartbeat', task: longTaskSummary(task, now()), snapshot,
        changes: { page: changed, dialogs: previousDialogDigest !== task.observation.dialogDigest },
        ...(pending() ? { user_action: { action: pending().action, reason: pending().reason, instruction: pending().instruction } } : {}),
        instruction: task.status === 'waiting_user' ? '保持只读监听，反馈用户所需操作；页面变化不等于用户完成反馈，不自动解除人工等待。'
          : task.status === 'awaiting_submission' ? 'Agent 阶段完成，保留页面等待用户交卷。'
            : (snapshot.dialogs || []).some(dialog => dialog.kind === 'proctoring') ? '只读监听监考提醒，请用户仅在考试页处理，不要求切屏聊天；提醒消失后重新定位，不执行确认/提交，不清除真实敏感等待。'
            : '长任务尚未完成。分析最新语义页面，恢复发现或继续下一题；一次监听窗口结束不代表任务结束。' };
    } catch {
      recordLongTaskResult(task, { ok: false, reason: 'observation_unavailable' }, now()); save();
      if (now() >= until) return { ok: false, status: 'needs_agent_review', reason: 'observation_unavailable',
        task: longTaskSummary(task, now()), instruction: '只读观察暂不可用，任务和进度仍保留；继续诊断连接并重新监听，不重放结果未知的动作。' };
    }
    await wait(Math.min(intervalMs, Math.max(0, until - now())), signal);
  }
}
