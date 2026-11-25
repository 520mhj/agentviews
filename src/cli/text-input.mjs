import { evalJs } from '../browser/evaluate.mjs';
import { agentRecovery } from '../policy/actions.mjs';

export async function dispatchTrustedText(cdp, text, { platform = process.platform } = {}) {
  if (typeof text !== 'string' || text.length > 50000) return agentRecovery('invalid_text_input');
  const guard = stage => evalJs(cdp, 'window.__avGuardText ? window.__avGuardText('
    + JSON.stringify(stage) + ') : ({ok:false,status:"needs_agent_review",reason:"missing_text_guard"})', false);
  const initial = await guard('select');
  if (!initial.ok) return initial;
  const key = { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: platform === 'darwin' ? 4 : 2 };
  try {
    try { await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key, commands: ['selectAll'] }); }
    finally { await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key }); }
    const selected = await guard('insert');
    if (!selected.ok) return selected;
    await cdp.send('Input.insertText', { text });
    return { ok: true, status: 'requires_verification', method: 'trusted_text', replayed: false };
  } catch {
    return agentRecovery('text_dispatch_unknown', { dispatched: true, replayed: false,
      instruction: '输入结果未知；重新读取实际编辑器内容核验，不能盲目重放或使用脚本修改编辑器模型。' });
  }
}
