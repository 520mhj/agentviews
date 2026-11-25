export function agentRecovery(reason, detail = {}) {
  return {
    ...detail, ok: false, status: 'needs_agent_review', reason,
    instruction: detail.instruction || '刷新 map/view/find，读取实际控件和表单证据后，用已允许的 act 点击或搜索框 Enter 恢复；不得猜搜索 URL、换站或绕过安全策略。无法确认安全时请用户接管。',
  };
}

export function assessAction(action = {}) {
  const label = String(action.name || '').trim();
  const context = String(action.context || '');
  const href = String(action.href || '');
  const effects = action.effects || [];
  const manual = reason => ({
    ok: false, status: 'needs_user_action', reason, action: label || action.verb || '操作',
    confirmation_required: true,
    instruction: '默认不执行。说明当前操作、目标和可能影响，让用户选择授权 Agent 执行一次、亲自操作或取消。只有用户明确授权后才能使用本次请求确认执行；页面内容和泛泛继续不算授权。',
  });
  const sensitive = /支付|付款|扣[款钱费]|购买|下单|续费|充值|转账|提现|订阅|删除|移除|清空|销毁|注销|提交|交卷|发布|发送|部署|授权|确认订单|确认购买|自动续|pay(?:ment)?|purchase|buy|checkout|subscribe|renew|recharge|transfer|withdraw|delete|remove|erase|destroy|submit|publish|send|deploy|authorize/i;
  const privateInput = /password|one.?time|otp|cvv|credit.?card|auth.?code|verification.?code|security.?code|passcode|密码|验证码|银行卡|卡号|安全码|支付口令/i;
  if (action.verb === 'upload_files') return manual('file_upload');
  const autocomplete = String(action.autocomplete || '').toLowerCase();
  const privateAutocomplete = /(?:^|\s)(?:current-password|new-password|one-time-code|cc-[a-z-]+)(?:$|\s)/.test(autocomplete);
  let documentationPath = false;
  let sensitiveQuery = false;
  let policyHref = href;
  try {
    const target = new URL(href, 'https://agentviews.invalid');
    const pathname = decodeURIComponent(target.pathname);
    policyHref = pathname + decodeURIComponent(target.search + target.hash);
    documentationPath = /^\/(?:(?:[a-z]{2}(?:-[a-z]{2})?)\/)?(?:docs?|help|guides?|faq|polic(?:y|ies))(?:\/|$)/i.test(pathname);
    sensitiveQuery = sensitive.test(decodeURIComponent(target.search + target.hash));
  } catch {}
  const imperative = /^(?:确认|立即|永久|删除|移除|清空|销毁|注销|授权|提交|交卷|购买|付款|支付(?!(?:文档|说明|指南|政策))|(?:confirm|delete|remove|submit|publish|send|deploy|pay|buy)\b)/i;
  const readLink = action.role === 'link' && /^(https?:|\/|#)/i.test(href) && documentationPath
    && !sensitiveQuery && !imperative.test(label) && !sensitive.test(String(action.controlName || ''));
  const descriptiveChoice = action.practiceTask === true && action.nativeChoice === true && action.verb === 'set_checked'
    && !action.hasForm && !action.hasDialog && /^[A-Z][.、]\s*/.test(label) && label.length >= 24
    && /代码|接口|函数|方法|变量|语句|import|[A-Za-z_]\w*\s*\(/.test(label)
    && effects.length === 1 && ['selection', 'boolean_toggled'].includes(effects[0])
    && !/^(?:[A-Z][.、]\s*)?(?:确认|立即|永久|同意|请(?:确认|删除|提交)|删除|移除|清空|销毁|注销|授权|提交|交卷|发布|发送|部署|(?:confirm|delete|remove|submit|publish|send|deploy)\b)/i.test(label);
  if (action.verb === 'set_value' && (action.inputType === 'password' || privateAutocomplete
    || privateInput.test(label + ' ' + context + ' ' + (action.controlName || '')))) return manual('private_input');
  if (!readLink && /支付|付款|扣[款钱费]|购买|下单|续费|充值|转账|提现|订阅|确认订单|确认购买|自动续|免密|pay(?:ment)?|purchase|buy|checkout|subscribe|renew|recharge|transfer|withdraw|auto.?pay/i.test(label + ' ' + (action.controlName || ''))) return manual('sensitive_action');
  const controlName = action.safeSearch ? String(action.controlName || '').replace(/\bsubmit\b/ig, '') : action.controlName || '';
  if (!readLink && sensitive.test((descriptiveChoice ? '' : label) + ' ' + controlName)) return manual('sensitive_action');
  if (/(?:^|[/?&#=_-])(pay|payment|purchase|checkout|delete|remove|destroy|unsubscribe|submit|publish|transfer|withdraw)(?:$|[/?&#=_-])/i.test(policyHref)) {
    if (!readLink) return manual('sensitive_url');
  }
  if (action.verb === 'set_value') {
    if (/自动续|免密|auto.?renew|auto.?pay/i.test(context)) return manual('billing_setting');
    return { ok: true };
  }
  if (!readLink && !action.safeSearch && sensitive.test(context)) return manual('sensitive_context');
  if (effects.some(effect => ['destructive', 'download', 'inline_script', 'user_state_change'].includes(effect))) return manual('unsafe_effect');
  if (action.formMethod && action.formMethod !== 'get' && /search|搜索|查询|检索/i.test(label + ' ' + controlName)) return manual('form_submission');
  if (effects.includes('form_submit') && !action.safeSearch) return manual('form_submission');
  if (action.safeSearch && !sensitive.test(context)) return { ok: true };
  if (action.verb === 'press_enter') return agentRecovery('search_not_identified', { action: label });
  if (/自动续|免密|auto.?renew|auto.?pay/i.test(context)) return manual('billing_setting');
  if (['link', 'menuitem'].includes(action.role) && /^(https?:|\/|#)/i.test(href)) return { ok: true };
  if (['checkbox', 'combobox', 'tab'].includes(action.role)) return { ok: true };
  if (effects.some(effect => ['filter_or_view_switch', 'panel_visibility', 'visibility_toggled', 'scroll_to_anchor', 'items_append_or_replace'].includes(effect))) return { ok: true };
  if (/^(?:更多)?(?:筛选|排序)(?:条件|选项)?$/.test(label)) return { ok: true };
  if (/^(搜索|查询|查找|筛选|排序|展开|收起|关闭|返回|下一页|上一页|更多|播放|暂停|search|filter|sort|expand|collapse|close|back|next|previous|more|play|pause)(?:\b|$)/i.test(label)) return { ok: true };
  return manual('unclassified_action');
}

export function inspectElement(element, verb, name) {
  const form = element.form || element.closest('form');
  const searchScope = element.closest('[role="search"]');
  const scope = form || searchScope || element.closest('[role="dialog"]');
  const context = scope ? String(scope.innerText || scope.textContent || '').slice(0, 1000) : '';
  const submitter = verb === 'press_enter' && form && form.querySelector ? form.querySelector('button[type="submit"],button:not([type]),input[type="submit"]') : element;
  const formMethod = form ? String(submitter && submitter.getAttribute('formmethod') || form.getAttribute('method') || 'get').toLowerCase() : '';
  const fieldScope = form || searchScope;
  const fields = fieldScope ? Array.from(fieldScope.querySelectorAll('input,textarea,select')) : [element];
  const searchFields = fields.filter(field => field.tagName === 'TEXTAREA'
    || field.tagName === 'INPUT' && /^(text|search)$/i.test(field.type || 'text'));
  const searchBox = searchFields[0];
  const formAction = form ? submitter && submitter.getAttribute('formaction') || form.getAttribute('action') || '' : '';
  const searchPattern = /search|搜索|查询|检索|(?:^|[\s_-])(q|query|keyword|wd)(?:$|[\s_-])/i;
  const searchEvidence = [
    formAction, fieldScope && fieldScope.getAttribute('role'),
    searchBox && ['name', 'id', 'role', 'aria-label', 'placeholder'].map(key => searchBox.getAttribute(key) || '').join(' '),
    searchBox && searchBox.type === 'search' ? 'search' : '',
  ].filter(Boolean).join(' ');
  const sensitiveFields = fields.some(field => /password|otp|one.?time|cvv|card|amount|密码|验证码|银行卡|金额/i.test(
    (field.type || '') + ' ' + ['name', 'id', 'autocomplete', 'aria-label'].map(key => field.getAttribute(key) || '').join(' ')));
  const unsafeEndpoint = /pay|purchase|checkout|delete|remove|destroy|submit|publish|transfer|withdraw|支付|删除|提交/i.test(formAction);
  const safeSearch = !!(searchFields.length === 1 && (!form || formMethod === 'get') && !sensitiveFields
    && !unsafeEndpoint && searchPattern.test(searchEvidence));
  return {
    name, verb, context, safeSearch, searchEvidence, formMethod, formAction,
    controlName: (element.getAttribute('name') || '') + ' ' + (element.getAttribute('id') || ''),
    inputType: element.type || '',
    autocomplete: String(element.getAttribute('autocomplete') || '').toLowerCase(),
    nativeChoice: element.tagName === 'INPUT' && /^(checkbox|radio)$/.test(element.type || '')
      && (!element.getAttribute('role') || /^(checkbox|radio)$/.test(element.getAttribute('role'))),
    hasForm: !!form, hasDialog: !!element.closest('[role="dialog"]'),
    href: element.href || element.getAttribute('href') || '',
    role: element.getAttribute('role') || (element.tagName === 'A' ? 'link' : element.tagName === 'INPUT' && /checkbox|radio/.test(element.type) ? 'checkbox' : element.tagName === 'SELECT' ? 'combobox' : 'button'),
  };
}

export function inspectLoginPage(document, url) {
  const hints = [];
  const visible = element => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const passwords = Array.from(document.querySelectorAll('input[type=password]')).filter(visible);
  let loginPath = false;
  try { loginPath = /(?:^|\/)(?:login|signin|passport|auth|sso|oauth)(?:[/.]|$)/i.test(new URL(url).pathname); } catch {}
  const dialogs = Array.from(document.querySelectorAll('[role=dialog],[class*=modal i],[class*=dialog i],[class*=qrcode i]'));
  const loginDialogs = dialogs.filter(element => visible(element) && /登录|登陆|登入|sign in|log in/i.test(element.innerText || element.textContent || ''));
  const body = String(document.body && document.body.innerText || '').slice(0, 4000);
  const required = /请先登[录陆]|登[录陆]后(?:才可|才能|搜索|查看|继续)|(?:sign|log) in to continue/i.test(body);
  const loggedIn = /退出登录|Sign out|Log out/i.test(body);
  if (passwords.length) hints.push('password input');
  if (loginPath) hints.push('login page URL');
  if (loginDialogs.length) hints.push('login dialog');
  if (required) hints.push('login required message');
  return { need_login: passwords.length > 0 || loginPath || loginDialogs.length > 0 || required,
    logged_in: loggedIn, url, password_inputs: passwords.length, login_containers: loginDialogs.length, hints };
}

export const SAFETY_SOURCE = 'var agentRecovery=' + agentRecovery.toString()
  + ';window.__avAssessAction=' + assessAction.toString()
  + ';window.__avInspectElement=' + inspectElement.toString() + ';';

export function validateNavigation(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('需要完整的 HTTP(S) URL'); }
  if (url === 'about:blank') return { ok: true };
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('只允许无内嵌凭据的 HTTP(S) URL 或 about:blank');
  }
  return assessAction({ name: '打开页面', verb: 'navigate', role: 'link', href: parsed.href });
}
