import { boundSemanticPage } from '../../core/semantic-page.mjs';

export function createReadCommands(context) {
  const { cdp, flags, positional, emit, evalJs, MAP_SRC, COLLECT_SRC } = context;
  return {
    observe: async () => {
      const snapshot = await evalJs(cdp, 'window.__av.snapshot', false);
      const delta = await evalJs(cdp, 'window.__av.diff', false);
      const limit = flags.full ? snapshot.nodes.length : Math.max(1, Math.min(200, Number(flags.max) || 40));
      emit(JSON.stringify({ ...boundSemanticPage(snapshot, { full: !!flags.full, max: flags.max }),
        delta: { ...delta, added: delta.added.slice(0, limit), removed: delta.removed.slice(0, limit), changed: delta.changed.slice(0, limit) } }, null, 2));
    },
    read: async () => {
      if (!flags.name && !flags.id) throw new Error('read 需要 --name 或 --id');
      emit(await evalJs(cdp, 'JSON.stringify(__av.read(' + JSON.stringify({ name: flags.name, id: flags.id, max: flags.max }) + '))', false));
    },
    "map": async () => {
      const m = await evalJs(cdp, MAP_SRC, false);
      m.product = 'agentviews';
      m.full = !!flags.full;
             if (flags.full) m.all_nodes = JSON.parse(await evalJs(cdp, 'JSON.stringify(__av.nodes)', false));
      else for (const c of m.capabilities) { c.total = c.nodes.length; c.nodes = c.nodes.slice(0, 14); }
      if (flags.json) return emit(JSON.stringify(m, null, 2));
      emit('# agentviews 地图  ' + m.site);
      emit('# ' + m.title + '  ·  ' + m.total_nodes + ' 个能力节点');
      for (const c of m.capabilities) {
        emit('');
        emit('## ' + c.use + '  (' + c.count + ')  — ' + c.hint);
        for (const x of c.nodes.slice(0, 14)) {
          emit('  ' + String(x.handle || '').slice(0, 44).padEnd(44) + ' ' +
               String(x.name || '').slice(0, 40) + '  [' + (x.effects || []).join(',') + ']');
        }
        if (c.count > c.nodes.length) emit('  …+' + (c.count - c.nodes.length));
      }
      return;
    },
    "collect": async () => {
      if (flags.max) await evalJs(cdp, 'window.__avCollectMax=' + (Number(flags.max) || 0), false).catch(() => {});
      if (flags.rounds) await evalJs(cdp, 'window.__avCollectRounds=' + (Number(flags.rounds) || 0), false).catch(() => {});
      const r = await evalJs(cdp, COLLECT_SRC, true);
      if (flags.json) return emit(JSON.stringify(r, null, 2));
      emit('# 结构化采集  ' + r.site + '  ·  ' + r.count + ' 条  ·  ' + r.rounds + ' 轮  ·  正文 ' + r.innertext_len + ' 字');
      emit('# href=null 表示这是内容块（正文），不是一条可跳转的条目');
      for (const it of r.items.slice(0, 30)) emit(JSON.stringify(it));
      if (r.count > 30) emit('# …+' + (r.count - 30) + ' 条，用 --json 取全量');
      return;
    },
    "view": async () => {
      if (flags.json) {
        return emit(JSON.stringify(await evalJs(cdp, '({stats:__av.stats, nodes:__av.nodes})', false), null, 2));
      }
      emit(await evalJs(cdp, 'window.__av.view', false));
      return;
    },
    "find": async () => {
      const q = positional[0] || '';
             const hits = await evalJs(cdp, `JSON.stringify(__av.byName(${JSON.stringify(q)}).slice(0,20).map(n=>{
        const a=(n.actions&&n.actions[0])||{};
        return {id:n.id,handle:n.handle,sec:n.sec,role:n.role,eff:a.effects||[],pre:a.preconditions||[],clickable:!!a.verb};
      }))`, false);
      emit(hits);
      return;
    },
    "verify": async () => {
      if (['url', 'contains', 'name', 'role', 'checked', 'selected', 'value', 'choices'].some(property => flags[property] !== undefined)) {
        const expected = taskAssertions(flags);
        emit(await evalJs(cdp, 'JSON.stringify(window.__avVerifyPage(__av.snapshot,' + JSON.stringify(expected) + '))', false));
        return;
      }
      const out = await evalJs(cdp, `JSON.stringify({
        url: location.href,
        selected: [...document.querySelectorAll('.selected,[aria-selected="true"],[aria-checked="true"],[aria-expanded="true"]')].map(e=>(e.textContent||'').trim().slice(0,30)).filter(Boolean).slice(0,8),
        checked: [...document.querySelectorAll('input[type=checkbox]:checked')].length,
        nodes: __av.nodes.length
      })`, false);
      emit(out);
      return;
    },
    "eval": async () => {
      const js = positional.join(' ');
      if (!js) throw new Error('需要表达式');
      const result = await cdp.send('Runtime.evaluate', {
        expression: js, returnByValue: true, throwOnSideEffect: true, timeout: 1000,
      });
      if (result.exceptionDetails) {
        const description = result.exceptionDetails.exception?.description || result.exceptionDetails.text || '表达式不可安全求值';
        emit(JSON.stringify({ ok: false, status: 'read_only_eval_rejected', reason: description,
          instruction: 'eval 仅允许无副作用读取；不能用脚本绕过人工付款、删除或提交边界。' }, null, 2));
        return;
      }
      const v = result.result?.value;
      emit(typeof v === 'string' ? v : JSON.stringify(v));
      return;
    },
    "audit": async () => {
      emit(await evalJs(cdp, 'JSON.stringify(__av.audit())', false));
      return;
    },
  };
}
import { taskAssertions } from './task.mjs';
