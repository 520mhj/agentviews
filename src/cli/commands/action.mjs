import { dispatchTrustedText } from '../text-input.mjs';
import { boundSemanticPage } from '../../core/semantic-page.mjs';
import { createActionConfirmation, checkActionConfirmation, publicActionConfirmation } from '../../core/action-confirmation.mjs';
import { prepareFileSelection, fileSelectionSummary } from '../../core/file-selection.mjs';
import { dispatchFileUpload } from '../file-upload.mjs';

export function createActionCommands(context) {
  const { cdp, flags, positional, emit, evalJs, MAP_SRC, ensureAv, tabs, saveTabs, CURR, agentRecovery, rememberHandoff, loginHandoff, dispatchSearchEnter, goto, sleep, dbg, human, waitStable, capabilityMap } = context;
  const requestConfirmation = (result, payload) => {
    const { approval_scope: scope, ...publicResult } = result;
    if (result.status !== 'needs_user_action') return publicResult;
    const state = tabs();
    state.action_confirmation = result.confirmation_required && typeof scope === 'string'
      ? createActionConfirmation({ payload, scope, tab: CURR, session: state.browser_session }) : null;
    const confirmation = state.action_confirmation ? publicActionConfirmation(state.action_confirmation) : null;
    const operation = Object.fromEntries(['verb', 'id', 'name', 'role', 'checked', 'files', 'upload_mode'].filter(property => payload[property] !== undefined).map(property => [property, payload[property]]));
    state.pending_user_action = { tab: CURR, ...publicResult, ...(confirmation ? { confirmation, operation } : {}) };
    saveTabs();
    return state.pending_user_action;
  };
  return {
    "search": async () => {
      const kw = positional.join(' ').trim();
      if (!kw) throw new Error('需要搜索关键词：agentviews search 军事新闻');
      const initialLogin = await loginHandoff(cdp);
      if (initialLogin) { emit(JSON.stringify(initialLogin, null, 2)); return; }
      const m = await evalJs(cdp, MAP_SRC, false);
      const candidates = await evalJs(cdp, '__av.searchCandidates()', false);
      const box = candidates.length === 1 ? candidates[0] : null;
      const detail = { product: 'agentviews', keyword: kw, from: m.site,
                       search_box: box ? box.name : null, reused_tab: true };
      if (!box) {
        emit(JSON.stringify(agentRecovery(candidates.length ? 'ambiguous_search_target' : 'search_target_not_found', { ...detail, candidates }), null, 2));
        return;
      }
      const fillPayload = { id: box.id, verb: 'set_value', text: kw };
      detail.fill = JSON.parse(await evalJs(cdp,
        `JSON.stringify(__av.act(${JSON.stringify(fillPayload)}))`, false));
      if (!detail.fill.ok) {
        emit(JSON.stringify(requestConfirmation(detail.fill, fillPayload), null, 2)); return;
      }
      const enterPayload = { id: box.id, verb: 'press_enter' };
      const permission = JSON.parse(await evalJs(cdp, `JSON.stringify(__av.act(${JSON.stringify(enterPayload)}))`, false));
      if (!permission.ok) {
        emit(JSON.stringify(requestConfirmation(permission, enterPayload), null, 2)); return;
      }
      const dispatched = await dispatchSearchEnter(cdp);
      if (!dispatched.ok) { emit(JSON.stringify(dispatched, null, 2)); return; }
      await sleep(900);
      await waitStable(cdp);
      await ensureAv(cdp, { refresh: true });
      const login = await loginHandoff(cdp);
      if (login) { emit(JSON.stringify({ ...detail, ...login }, null, 2)); return; }
      const stats = await evalJs(cdp, 'window.__av.stats', false);
      detail.url = await evalJs(cdp, 'location.href', false);
      detail.stats = stats;
      detail.ok = true;
      detail.status = 'requires_verification';
      detail.task_completed = false;
      detail.instruction = '已派发搜索；读取结果并验证关键词、来源和目标内容后才能判断任务成功。同页无变化时刷新 map，检查搜索按钮或异步结果，不构造搜索 URL。';
      if (flags.json) {
        detail.view = await evalJs(cdp, 'window.__av.view', false);
        return emit(JSON.stringify(detail, null, 2));
      }
      emit('# agentviews search  ' + kw + '  →  ' + detail.url);
      emit('# ' + human(stats));
      emit(await evalJs(cdp, 'window.__av.view', false));
      return;
    },
    "act": async () => {
      if (tabs().pending_user_action && !flags.confirm && !flags['user-confirmed']) { emit(JSON.stringify(tabs().pending_user_action, null, 2)); return; }
      const name = flags.name, id = flags.id;
      if (!name && !id) throw new Error('需要 --name 或 --id');
      if (flags.key && (flags.key !== 'Enter' || flags.text !== undefined)) throw new Error('--key 仅支持 Enter，且不能与 --text 同用');
      const modes = [flags.key, flags.text, flags.option, flags.checked, flags.files].filter(value => value !== undefined);
      if (modes.length > 1) throw new Error('text/key/option/checked/files 只能选择一种操作');
      if (flags.drop && flags.files === undefined) throw new Error('--drop 需要 --files');
      if (flags.checked !== undefined && !['true', 'false'].includes(flags.checked)) throw new Error('--checked 仅接受 true 或 false');
      const selection = flags.files !== undefined ? prepareFileSelection(JSON.parse(flags.files)) : null;
      const payload = { verb: selection ? 'upload_files' : flags.key ? 'press_enter' : flags.text !== undefined ? 'set_value' : flags.option !== undefined ? 'select' : flags.checked !== undefined ? 'set_checked' : 'click' };
      if (name) payload.name = name; else payload.id = id;
      if (flags.role) payload.role = flags.role;
      if (flags.text !== undefined) payload.text = flags.text;
      if (flags.option !== undefined) payload.option = flags.option;
      if (flags.checked !== undefined) payload.checked = flags.checked === 'true';
      if (selection) { payload.files = fileSelectionSummary(selection); payload.upload_mode = flags.drop ? 'drop' : 'input'; }
      let confirmation = null;
      if (flags.confirm || flags['user-confirmed']) {
        const state = tabs();
        const request = state.action_confirmation;
        const input = { request, requestId: flags.confirm, userConfirmed: flags['user-confirmed'], payload,
          tab: CURR, session: state.browser_session };
        const validity = checkActionConfirmation(input);
        if (!validity.ok) { emit(JSON.stringify(agentRecovery(validity.reason), null, 2)); return; }
        state.action_confirmation = null;
        state.pending_user_action = { tab: CURR, ok: false, status: 'needs_user_action', reason: 'confirmation_consumed',
          confirmation: publicActionConfirmation(request),
          instruction: '本次授权已消费。先读取并核验执行结果；不能复用授权或盲目重放。用户亲自操作后可 resume --user-done；取消等待可 resume --decline。' };
        saveTabs();
        const probe = JSON.parse(await evalJs(cdp, `JSON.stringify(__av.act(${JSON.stringify({ ...payload, preview: true })}))`, false));
        const fresh = checkActionConfirmation({ ...input, scope: probe.approval_scope });
        if (typeof probe.approval_scope !== 'string' || !fresh.ok) {
          emit(JSON.stringify(agentRecovery(fresh.ok ? probe.reason || 'confirmation_target_unavailable' : fresh.reason, { confirmation_consumed: true }), null, 2)); return;
        }
        confirmation = publicActionConfirmation(request);
        payload.approval = { scope: probe.approval_scope, expires_at: request.expires_at };
      }
      const expr = `JSON.stringify(__av.act(${JSON.stringify(payload)}))`;
      dbg('act', { verb: payload.verb, confirmed: !!confirmation });
      const res = JSON.parse(await evalJs(cdp, expr, false));
      if (res.status === 'needs_user_action') {
        emit(JSON.stringify(requestConfirmation(res, payload), null, 2));
        return;
      }
      if (!res.ok) { emit(JSON.stringify(res, null, 2)); return; }
      if (res.file_upload) {
        const uploaded = await dispatchFileUpload(cdp, selection, res.file_upload);
        if (!uploaded.ok) { emit(JSON.stringify(uploaded, null, 2)); return; }
        res.upload = uploaded;
      }
      if (res.trusted_text) {
        const dispatched = await dispatchTrustedText(cdp, payload.text);
        if (!dispatched.ok) { rememberHandoff(dispatched); emit(JSON.stringify(dispatched, null, 2)); return; }
      }
      if (res.key) {
        const dispatched = await dispatchSearchEnter(cdp);
        if (!dispatched.ok) { emit(JSON.stringify(dispatched, null, 2)); return; }
        await sleep(900);
      }
      if (res.same_tab_url) await goto(cdp, res.same_tab_url);
      let clicked = null;
      if (res.ok && res.point) {
        const [px, py] = res.point;
        const base = { x: px, y: py, button: 'left', clickCount: 1 };
               await evalJs(cdp, `(()=>{window.__avClicks=[];if(!window.__avArmed){window.__avArmed=1;document.addEventListener('click',function(e){if(e.isTrusted)window.__avClicks.push([e.clientX,e.clientY])},true)}return 1})()`, false).catch(() => {});
        const permission = await evalJs(cdp, 'window.__avGuardHit ? window.__avGuardHit() : ({ok:false,status:"needs_agent_review",reason:"missing_target_guard"})', false);
        if (!permission.ok) {
          rememberHandoff(permission);
          emit(JSON.stringify(permission, null, 2)); return;
        }
        try {
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py });
          try { await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base }); }
          finally { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base }); }
          clicked = 'cdp-trusted';
        } catch (e) {
          clicked = 'failed:' + e.message;
        }
        await sleep(80);
        const landed = await evalJs(cdp, '(()=>{try{return (window.__avClicks||[]).length>0}catch(e){return false}})()', false).catch(() => false);
        if (!landed) {
          const rechecked = await evalJs(cdp, 'window.__avGuardHit ? window.__avGuardHit() : ({ok:false,status:"needs_agent_review",reason:"stale_click_target"})', false)
            .catch(error => agentRecovery('click_result_unknown', { error: error.message }));
          if (!rechecked.ok) { emit(JSON.stringify(rememberHandoff(rechecked), null, 2)); return; }
          emit(JSON.stringify(agentRecovery('click_not_observed', { dispatched: clicked, replayed: false }), null, 2));
          return;
        }
      }
             let settled;
      if (!res.ok) {
        settled = JSON.stringify({ settled_ms: 0, reason: 'skipped' });
      } else {
        try {
          settled = await evalJs(cdp, `__av.settle(4000).then(r => JSON.stringify(r))`, true);
        } catch {
          settled = JSON.stringify({ settled_ms: 0, reason: 'navigated' });
        }
      }

      if (JSON.parse(settled).reason === 'navigated') await waitStable(cdp);
      await ensureAv(cdp, { refresh: true });
      if (payload.verb !== 'set_value') {
        const login = await loginHandoff(cdp);
        if (login) { emit(JSON.stringify({ act: res, ...login }, null, 2)); return; }
      }
      const stats = await evalJs(cdp, 'window.__av.stats', false);
      const am = flags.map ? await capabilityMap(cdp) : null;
      const after = flags.observe ? boundSemanticPage(await evalJs(cdp, 'window.__av.snapshot', false), { full: !!flags.full, max: flags.max }) : null;
      if (confirmation && tabs().pending_user_action?.reason === 'confirmation_consumed') {
        tabs().pending_user_action = null;
        if (tabs().long_task?.status === 'waiting_user') tabs().long_task.status = 'verifying';
        saveTabs();
      }
      if (flags.json) return emit(JSON.stringify({ ok: true, status: 'requires_verification', task_completed: false, act: res, settle: JSON.parse(settled), stats,
        ...(confirmation ? { confirmation_consumed: true, confirmation } : {}),
        ...(am ? { after_map: am } : {}), ...(after ? { after_observation: after } : {}) }, null, 2));
      emit(`act → ${JSON.stringify(res)}`);
      emit(`settle → ${settled}`);
      emit(`# ${human(stats)}`);
      if (am) emit('# after-map → ' + JSON.stringify({ site: am.site, title: am.title, total_nodes: am.total_nodes, capabilities: am.capabilities.map(x => ({ use: x.use, count: x.count })) }));
      return;
    },
  };
}
