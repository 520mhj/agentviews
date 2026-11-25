import { startLongTask, isLongTaskOpen, longTaskSummary, observeLongTask, checkpointLongTask, readyLongTask, watchLongTask } from '../../core/long-task.mjs';
import { boundSemanticPage, verifySemanticPage } from '../../core/semantic-page.mjs';

export function taskAssertions(flags) {
  const expected = {};
  for (const property of ['url', 'contains', 'name', 'role', 'value']) if (flags[property] !== undefined) expected[property] = flags[property];
  for (const property of ['checked', 'selected']) {
    if (flags[property] === undefined) continue;
    if (!['true', 'false'].includes(flags[property])) throw new Error('--' + property + ' 仅接受 true 或 false');
    expected[property] = flags[property] === 'true';
  }
  if (flags.choices !== undefined) {
    expected.choices = JSON.parse(flags.choices);
    if (!Array.isArray(expected.choices) || !expected.choices.length || expected.choices.length > 20) throw new Error('--choices 必须为包含 1–20 个选项状态断言的 JSON 数组');
  }
  return expected;
}

export function createTaskCommands(context) {
  const { cdp, flags, positional, emit, evalJs, ensureAv, tabs, saveTabs, CURR, listPages } = context;
  return {
    task: async () => {
      const operation = positional[0] || 'status';
      const state = tabs();
      if (operation === 'preflight') {
        await ensureAv(cdp, { refresh: true });
        const snapshot = await evalJs(cdp, 'window.__av.snapshot', false);
        const candidates = snapshot.nodes.filter(node => node.editor && !node.states.includes('disabled') && !node.states.includes('readonly'));
        const unsupported = snapshot.nodes.filter(node => node.editor_capability?.supported === false)
          .map(node => ({ id: node.id, name: node.name, capability: node.editor_capability }));
        const editors = [];
        for (const node of candidates) {
          const probe = await evalJs(cdp, '__av.read(' + JSON.stringify({ id: node.id, max: 1 }) + ')', false);
          editors.push({ id: node.id, name: node.name, driver: node.editor, readable: probe.ok === true,
            driver_supported: probe.ok === true && node.editor_whitespace_preserved !== false, live_writing_verified: false });
        }
        emit(JSON.stringify({ ok: true, status: editors.some(editor => editor.driver_supported) ? 'editor_detected_unverified' : 'needs_editor_page',
          tab: CURR, title: snapshot.title, url: snapshot.url, editors, unsupported, frames: snapshot.frames, dialogs: snapshot.dialogs, live_writing_verified: false,
          instruction: '此预检只读，未输入代码、开考、运行或提交；发现编辑器不代表真实站点写入已验证。先读题目与语言要求，再在允许的非计次练习中核验写入和读回。' }, null, 2)); return;
      }
      if (operation === 'start') {
        if (isLongTaskOpen(state.long_task)) throw new Error('已有长任务；沿用进度，不能重新开始消耗考试机会');
        if (!state.curr || state.curr !== CURR) throw new Error('先显式选择当前标签页或工具自有页面');
        state.long_task = startLongTask({ tab: state.curr, goal: flags.goal, total: Number(flags.total), kind: flags.kind || 'workflow',
          timeoutSec: flags.timeout === undefined ? 3600 : Number(flags.timeout), authorized: flags.authorized === true });
        if (state.pending_user_action) state.long_task.status = 'waiting_user';
        saveTabs();
      }
      const task = state.long_task;
      if (!task) throw new Error('尚未创建长任务，先 task start');
      if (operation === 'start' || operation === 'status') {
        const summary = longTaskSummary(task); saveTabs(); emit(JSON.stringify({ ok: true, task: summary }, null, 2)); return;
      }
      if (operation === 'cancel') {
        state.action_confirmation = null;
        task.status = 'cancelled'; task.reason = 'user_cancelled'; task.updatedAt = Date.now(); saveTabs();
        emit(JSON.stringify({ ok: true, task: longTaskSummary(task), kept: true, instruction: '取消任务并撤销待执行确认；不关闭页面、不提交、不清除待核验的用户操作。' }, null, 2)); return;
      }
      if (CURR !== task.tab) throw new Error('长任务目标不匹配，不能切换标签页');
      const observe = async () => {
        await ensureAv(cdp, { refresh: true });
        return evalJs(cdp, 'window.__av.snapshot', false);
      };
      if (operation === 'watch') {
        const controller = new AbortController();
        const cancelled = () => controller.abort();
        const wait = (milliseconds, signal) => new Promise(resolve => {
          const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
          const timer = setTimeout(finish, milliseconds);
          signal.addEventListener('abort', finish, { once: true });
          if (signal.aborted) finish();
        });
        process.once('SIGINT', cancelled); process.once('SIGTERM', cancelled);
        try {
          const result = await watchLongTask({ task, observe, save: saveTabs, pending: () => state.pending_user_action,
            targetExists: async tab => (await listPages()).some(page => page.id === tab),
            timeoutMs: flags.timeout === undefined ? 5000 : Number(flags.timeout) * 1000,
            intervalMs: flags.beat === undefined ? 1000 : Number(flags.beat) * 1000, signal: controller.signal, wait });
          if (result.snapshot) {
            result.snapshot = boundSemanticPage(result.snapshot, { full: !!flags.full, max: flags.max });
          }
          emit(JSON.stringify(result, null, 2));
        } finally { process.removeListener('SIGINT', cancelled); process.removeListener('SIGTERM', cancelled); }
        return;
      }
      if (!['checkpoint', 'ready', 'complete', 'submitted', 'interrupt'].includes(operation)) throw new Error('task 支持 preflight/start/status/watch/checkpoint/ready/complete/submitted/interrupt/cancel');
      if (operation === 'complete' && task.kind !== 'workflow') throw new Error('complete 仅用于通用 workflow，不能替代用户亲自提交或解除人工等待');
      if (operation === 'submitted' && (flags['user-done'] !== true || task.status !== 'awaiting_submission' || state.pending_user_action)) {
        throw new Error('必须先完成 Agent 阶段并收到用户亲自交卷后的明确反馈；人工等待先 resume 复核');
      }
      if (!isLongTaskOpen(task) || ['expired', 'target_lost', 'interrupted'].includes(task.status)) throw new Error('该任务不可继续作答或宣布完成；请用户决定，不自动重新开考');
      const snapshot = await observe();
      observeLongTask(task, snapshot);
      const expected = taskAssertions(flags);
      let result;
      if (operation === 'interrupt') {
        if (!expected.contains?.trim() && !expected.url) throw new Error('中断需要实际结束页面的明确文本或 URL 断言');
        result = verifySemanticPage(snapshot, expected);
        if (result.ok) { task.status = 'interrupted'; task.reason = 'external_end_observed'; task.updatedAt = Date.now(); }
        result.task = longTaskSummary(task);
      } else if (operation === 'checkpoint') result = checkpointLongTask(task, { step: Number(flags.step), expected, snapshot, pending: state.pending_user_action, origin: flags.origin });
      else if (operation === 'ready' || operation === 'complete') {
        result = readyLongTask(task, { expected, snapshot, pending: state.pending_user_action });
        if (operation === 'complete' && result.ok) {
          task.status = 'completed'; task.reason = 'page_assertions_verified'; task.updatedAt = Date.now();
          result = { ...result, status: 'completed', task: longTaskSummary(task), instruction: '所声明的页面断言已验证；这不是付款、提交或外部业务结果的证明。' };
        }
      }
      else {
        if (!expected.contains?.trim()) throw new Error('需要交卷成功页面的非空文本断言');
        result = await evalJs(cdp, 'window.__avVerifyPage(__av.snapshot,' + JSON.stringify(expected) + ')', false);
        if (result.ok) { task.status = 'completed'; task.reason = 'user_submission_verified'; task.updatedAt = Date.now(); }
        result.task = longTaskSummary(task);
      }
      saveTabs(); emit(JSON.stringify(result, null, 2));
    },
  };
}
