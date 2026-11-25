import test from 'node:test';
import assert from 'node:assert/strict';
import { assessAction, inspectElement, inspectLoginPage } from '../safety.mjs';

function field(attributes = {}) {
  return { tagName: 'INPUT', type: attributes.type || 'text', getAttribute: key => attributes[key] ?? null };
}

function searchForm({ method = 'get', action = '/search.aspx', fields = [field({ name: 'value' })] } = {}) {
  const form = { textContent: '', getAttribute: key => ({ method, action })[key] ?? null, querySelectorAll: () => fields };
  const element = { ...fields[0], form, closest: () => form };
  return inspectElement(element, 'press_enter', 'value');
}

test('search evidence supports unknown GET field names but not arbitrary forms', () => {
  const info = searchForm();
  assert.equal(info.safeSearch, true);
  assert.equal(assessAction({ ...info, effects: ['form_submit'] }).ok, true);
  for (const options of [
    { method: 'post' }, { action: '/checkout/search' }, { action: '/delete' }, { action: '/profile' },
    { fields: [field({ name: 'value' }), field({ type: 'password' })] },
    { fields: [field({ name: 'value' }), field({ name: 'amount', type: 'hidden' })] },
    { fields: [field({ name: 'value' }), field({ autocomplete: 'one-time-code' })] },
    { fields: [field({ name: 'value' }), field({ name: 'other' })] },
  ]) {
    const result = searchForm(options);
    assert.equal(result.safeSearch, false, JSON.stringify(options));
    assert.equal(assessAction({ ...result, effects: ['form_submit'] }).status, 'needs_user_action');
  }
});

test('positive search evidence never overrides confirmed sensitive controls', () => {
  for (const name of ['付款', '删除', '提交', '发布', '确认购买']) {
    assert.equal(assessAction({ ...searchForm(), name, effects: ['form_submit'] }).status, 'needs_user_action');
  }
  assert.equal(assessAction({ ...searchForm(), name: '搜索', controlName: 'submit btnSearch', effects: ['form_submit'] }).ok, true);
  assert.equal(assessAction({ name: 'value', controlName: 'otp', verb: 'set_value' }).reason, 'private_input');
  assert.equal(assessAction({ name: 'term', verb: 'press_enter' }).status, 'needs_agent_review');
  assert.equal(assessAction({ ...searchForm({ method: 'post' }), name: '搜索', verb: 'click', effects: ['network_request'] }).reason, 'form_submission');
});

test('documentation query hints cannot exempt destructive links or credential fields', () => {
  for (const href of ['https://example.com/delete?help=1', 'https://example.com/%64elete?help=1', 'https://example.com/remove#guide', 'https://example.com/submit?docs=1']) {
    assert.equal(assessAction({ name: '帮助', verb: 'click', role: 'link', href, effects: ['open_new_tab'] }).status, 'needs_user_action');
  }
  assert.equal(assessAction({ name: '删除账号', verb: 'click', role: 'link', href: 'https://example.com/docs/delete', effects: ['open_new_tab'] }).status, 'needs_user_action');
  assert.equal(assessAction({ name: '支付文档', verb: 'click', role: 'link', href: 'https://example.com/docs/payment' }).ok, true);
  assert.equal(assessAction({ name: '帮助', verb: 'click', role: 'link', href: 'https://example.com/docs?action=delete' }).status, 'needs_user_action');
  for (const autocomplete of ['one-time-code', 'current-password', 'new-password', 'cc-number', 'section-billing cc-csc']) {
    const element = { ...field({ autocomplete }), closest: () => null };
    const info = inspectElement(element, 'set_value', 'Security code');
    assert.equal(info.autocomplete, autocomplete);
    assert.equal(assessAction(info).reason, 'private_input');
  }
  assert.equal(assessAction({ verb: 'set_value', name: '编号', controlName: 'authcode' }).reason, 'private_input');
});

test('authorized descriptive native choices do not confuse API or import explanations with operations', () => {
  const choice = { verb: 'set_checked', role: 'checkbox', nativeChoice: true, practiceTask: true, effects: ['selection'] };
  const labels = [
    'B.sendData() 的有效性与 Task 存活状态绑定，异步回调中调用该接口可能引发异常',
    'D.为了清理未使用的import，可以调用编辑器方法自动移除未使用的import语句并进行排序',
  ];
  for (const name of labels) {
    assert.equal(assessAction({ ...choice, name }).ok, true);
    assert.equal(assessAction({ ...choice, name, practiceTask: false }).status, 'needs_user_action');
    assert.equal(assessAction({ ...choice, name, nativeChoice: false }).status, 'needs_user_action');
    assert.equal(assessAction({ ...choice, name, verb: 'click' }).status, 'needs_user_action');
    for (const extra of [{ hasForm: true }, { hasDialog: true }, { href: '/delete' }, { controlName: 'deleteAccount' }, { effects: ['destructive'] }]) {
      assert.equal(assessAction({ ...choice, name, ...extra }).status, 'needs_user_action');
    }
  }
});

test('practice scope cannot authorize payments or real imperative deletion and submission', () => {
  for (const name of ['A.确认付款', 'D.删除资源并调用接口清空代码和变量后永久销毁账户',
    'B.为了执行代码验证接口，请先自动购买并续费这个付费套餐', 'C.提交并交卷', 'D.立即移除所有资源文件']) {
    assert.equal(assessAction({ name, verb: 'set_checked', role: 'checkbox', nativeChoice: true, practiceTask: true, effects: ['selection'] }).status, 'needs_user_action');
  }
});

function loginDocument({ text = '', password = false, dialog = false } = {}) {
  const element = { innerText: '登录', getBoundingClientRect: () => ({ width: 100, height: 30 }) };
  return { body: { innerText: text }, querySelectorAll: selector => selector === 'input[type=password]' ? password ? [element] : [] : dialog ? [element] : [] };
}

test('login detection distinguishes a blocking login page from an optional login link', () => {
  assert.equal(inspectLoginPage(loginDocument({ text: '首页 登录 推荐内容' }), 'https://example.com').need_login, false);
  assert.equal(inspectLoginPage(loginDocument(), 'https://example.com/search?q=login').need_login, false);
  assert.equal(inspectLoginPage(loginDocument(), 'https://example.com/user/login.aspx').need_login, true);
  assert.equal(inspectLoginPage(loginDocument({ password: true }), 'https://example.com').need_login, true);
  assert.equal(inspectLoginPage(loginDocument({ dialog: true }), 'https://example.com').need_login, true);
  assert.equal(inspectLoginPage(loginDocument({ text: '请先登录后搜索' }), 'https://example.com').need_login, true);
});
