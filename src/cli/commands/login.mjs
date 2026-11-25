export function createLoginCommands(context) {
  const { cdp, flags, emit, evalJs, tabs, saveTabs, CURR, loginHandoff, loginProbe, writeFileSync, isAttach, browserLabel, watchLogin } = context;
  return {
    "resume": async () => {
      const pending = tabs().pending_user_action;
      if (flags.decline) {
        if (flags.skip || flags['user-done']) throw new Error('取消、完成与跳过不能同时选择');
        if (!pending || pending.reason === 'login_required') throw new Error('没有可取消的操作确认；登录任务使用 resume --skip');
        const requestId = tabs().action_confirmation?.request_id || pending.confirmation?.request_id;
        if (requestId && flags['request-id'] !== requestId) throw new Error('取消确认需要匹配 --request-id');
        tabs().pending_user_action = null;
        tabs().action_confirmation = null;
        if (tabs().long_task?.status === 'waiting_user') tabs().long_task.status = 'verifying';
        saveTabs();
        emit(JSON.stringify({ ok: false, status: 'user_action_declined', executed: false, kept: true }, null, 2)); return;
      }
      if (flags.skip) {
        if (!pending || pending.reason !== 'login_required') throw new Error('resume --skip 仅用于用户明确跳过的登录阻塞任务');
        tabs().pending_user_action = null;
        tabs().action_confirmation = null;
        if (tabs().long_task && !['completed', 'cancelled'].includes(tabs().long_task.status)) {
          tabs().long_task.status = 'cancelled'; tabs().long_task.reason = 'user_skipped_login';
        }
        tabs().user_current = pending.tab;
        if (!tabs().baseline.includes(pending.tab)) tabs().baseline.push(pending.tab);
        saveTabs();
        emit(JSON.stringify({ ok: false, status: 'task_skipped', task_completed: false, tab: pending.tab, kept: true }, null, 2));
        return;
      }
      if (!flags['user-done']) throw new Error('先向用户反馈并等待“已完成”回复，再运行 resume --user-done；这不是自动重试授权');
      if (pending && pending.reason === 'login_required') {
        const login = await loginHandoff(cdp);
        if (login) { emit(JSON.stringify(login, null, 2)); return; }
      }
      const evidence = await evalJs(cdp, '({url:location.href,title:document.title,text:(document.body.innerText||"").slice(0,1500)})', false);
      tabs().pending_user_action = null;
      tabs().action_confirmation = null;
      if (tabs().long_task?.status === 'waiting_user') {
        tabs().long_task.status = 'verifying'; tabs().long_task.reason = 'user_result_requires_verification';
      }
      if (pending) {
        tabs().user_current = pending.tab;
        if (!tabs().baseline.includes(pending.tab)) tabs().baseline.push(pending.tab);
      }
      saveTabs();
      emit(JSON.stringify({ status: 'user_result_requires_verification', replayed: false, pending, evidence,
        instruction: '对照用户反馈与页面证据核验实际结果，再继续低风险步骤；未自动执行此前被拦截的动作。' }, null, 2));
      return;
    },
    "login-check": async () => {
      const r = await loginProbe(cdp);
      r.browser = browserLabel();
      r.tab = isAttach() ? tabs().curr : CURR;
      if (flags.shot) {
        const out = typeof flags.shot === 'string' ? flags.shot : 'agentviews/login.png';
        try {
          const s = await cdp.send('Page.captureScreenshot', { format: 'png' });
          writeFileSync(out, Buffer.from(s.data, 'base64'));
          r.shot = out;
        } catch (e) { r.shot_error = e.message; }
      }
      r.advice = r.need_login
        ? '需要登录：请在 ' + browserLabel() + ' 里自己开的那个标签页完成登录，然后继续；或用 login-wait 阻塞等待'
        : '未检测到登录要求，可继续任务';
      emit(JSON.stringify(r, null, 2));
      return;
    },
    "login-wait": async () => {
      if (flags.idle !== undefined) throw new Error('--idle 已移除；登录等待使用 --timeout 与 --beat，不修改用户页面');
      const sec = Math.max(5, Math.min(1800, Number(flags.timeout) || 90));
      const beatSec = Math.max(1, Math.min(60, Number(flags.beat) || 5));
      const r = await watchLogin(cdp, { timeoutSec: sec, beatSec, freeze: !!flags.freeze });
      r.browser = browserLabel();
      r.tab = isAttach() ? tabs().curr : CURR;
      emit(JSON.stringify(r, null, 2));
      return;
    },
    "login-watch": async () => {
      if (flags.idle !== undefined) throw new Error('--idle 已移除；登录等待使用 --timeout 与 --beat，不修改用户页面');
      const sec = Math.max(5, Math.min(1800, Number(flags.timeout) || (cmd === 'login-watch' ? 300 : 90)));
      const beatSec = Math.max(1, Math.min(60, Number(flags.beat) || 5));
      const r = await watchLogin(cdp, { timeoutSec: sec, beatSec, freeze: !!flags.freeze });
      r.browser = browserLabel();
      r.tab = isAttach() ? tabs().curr : CURR;
      emit(JSON.stringify(r, null, 2));
      return;
    },
  };
}
