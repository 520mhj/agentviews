import test from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { SAFETY_SOURCE } from '../safety.mjs';
import { createBrowserSource } from '../src/browser/source.mjs';

function page({ tag = 'BUTTON', name, attributes = {}, current = true, formAttributes = null }) {
  let clicks = 0;
  let observers = 0;
  let mediaObserver;
  const target = {
    tagName: tag, textContent: name, className: '', children: [], isConnected: true,
    type: attributes.type || (tag === 'INPUT' ? 'text' : 'button'), target: attributes.target || '', href: attributes.href || '',
    getAttribute: key => attributes[key] ?? null,
    hasAttribute: key => attributes[key] !== undefined,
    querySelector: () => null, querySelectorAll: () => [],
    closest: selector => selector === 'form' ? form : tag === 'A' && selector.startsWith('a') ? target : null,
    getBoundingClientRect: () => ({ x: 10, y: 10, left: 10, top: 10, right: 110, bottom: 50, width: 100, height: 40 }),
    contains: element => element === target, click: () => { clicks++; },
    focus: () => { document.activeElement = target; }, dispatchEvent: () => {},
  };
  const form = formAttributes ? { innerText: '', getAttribute: key => formAttributes[key] ?? null,
    querySelectorAll: () => [target] } : null;
  target.form = form;
  const body = { ...target, tagName: 'BODY', textContent: '', children: [target],
    getAttribute: () => null, closest: () => null };
  target.parentElement = body;
  const media = { muted: false, volume: 1, paused: false, played: false };
  const document = {
    body, documentElement: { outerHTML: '<html><body>fixture</body></html>' },
    querySelectorAll: selector => selector === 'video,audio' ? [media] : [], querySelector: () => null, getElementById: () => null,
    elementFromPoint: () => target,
  };
  class Observer {
    constructor(callback) { observers++; mediaObserver = callback; }
    observe() {}
    disconnect() {}
  }
  class Media {}
  const originalPlay = function () { this.played = true; };
  Media.prototype.play = originalPlay;
  const window = { __avCurrentTabOnly: current };
  const context = createContext({ window, document, innerWidth: 800, innerHeight: 600,
    location: { href: 'https://example.com' }, URL, CSS: { escape: value => value },
    HTMLMediaElement: Media, MutationObserver: Observer,
    Event: class {}, KeyboardEvent: class {},
    getComputedStyle: element => ({ display: 'block', visibility: 'visible', opacity: '1', cursor: element === target ? 'pointer' : 'default' }),
  });
  runInContext(createBrowserSource({ currentTab: current }), context);
  return { window, context, media, target, document, formAttributes, clicks: () => clicks, observers: () => observers, play: () => Media.prototype.play, originalPlay,
    addMedia: element => mediaObserver([{ addedNodes: [element] }]) };
}

function styledChoice(name = '选项B') {
  const fixture = page({ tag: 'INPUT', name: '', attributes: { type: 'radio' } });
  const native = fixture.target;
  native.checked = false;
  const label = { ...native, tagName: 'LABEL', textContent: name, control: native,
    getAttribute: () => null, closest: () => null, contains: element => [label, marker, native].includes(element),
    querySelector: selector => selector === 'input,select,textarea' ? native : null };
  const marker = { ...label, tagName: 'SPAN', textContent: '', control: undefined,
    closest: selector => selector === 'label' ? label : null,
    contains: element => element === marker || element === native,
    querySelector: () => null, children: [native], parentElement: label };
  label.children = [marker];
  label.parentElement = fixture.document.body;
  native.parentElement = marker;
  native.closest = selector => selector === 'label' ? label : null;
  fixture.document.body.children = [label];
  fixture.document.elementFromPoint = () => marker;
  fixture.context.getComputedStyle = element => ({ display: 'block', visibility: 'visible',
    opacity: element === native ? '0' : '1', cursor: 'default' });
  runInContext(createBrowserSource({ currentTab: true }), fixture.context);
  return { ...fixture, label, marker, native };
}

test('sensitive actions default to a scoped request and run only with matching host approval', () => {
  const fixture = page({ name: '提交', formAttributes: { method: 'post', action: '/commit' } });
  const payload = { name: '提交', role: 'button', verb: 'click' };
  const request = fixture.window.__av.act(payload);
  assert.equal(request.status, 'needs_user_action');
  assert.equal(request.confirmation_required, true);
  assert.equal(fixture.clicks(), 0);
  const preview = fixture.window.__av.act({ ...payload, preview: true });
  assert.equal(preview.approval_scope, request.approval_scope);
  const approval = { scope: request.approval_scope, expires_at: Date.now() + 5000 };
  const result = fixture.window.__av.act({ ...payload, approval });
  assert.equal(result.ok, true);
  assert.ok(result.point);
  assert.equal(fixture.window.__avGuardHit().ok, true);
  fixture.formAttributes.action = '/delete';
  assert.equal(fixture.window.__avGuardHit().reason, 'confirmation_page_changed');
});

test('approval survives fresh observations of the same element but not replacement or expiry', () => {
  const fixture = page({ name: '提交' });
  const payload = { name: '提交', verb: 'click' };
  const request = fixture.window.__av.act(payload);
  const approval = { scope: request.approval_scope, expires_at: Date.now() + 5000 };
  runInContext(createBrowserSource({ currentTab: true }), fixture.context);
  assert.equal(fixture.window.__av.act({ ...payload, approval }).ok, true);
  assert.equal(fixture.window.__av.act({ ...payload, approval: { ...approval, expires_at: 0 } }).reason, 'confirmation_page_changed');
  const replacement = { ...fixture.target };
  fixture.document.body.children = [replacement];
  fixture.document.elementFromPoint = () => replacement;
  runInContext(createBrowserSource({ currentTab: true }), fixture.context);
  assert.equal(fixture.window.__av.act({ ...payload, approval }).reason, 'confirmation_page_changed');
  assert.equal(fixture.clicks(), 0);
});

test('approval does not bypass disabled or obscured controls', () => {
  const fixture = page({ name: '提交' });
  const payload = { name: '提交', verb: 'click' };
  const request = fixture.window.__av.act(payload);
  const approval = { scope: request.approval_scope, expires_at: Date.now() + 5000 };
  fixture.target.disabled = true;
  assert.equal(fixture.window.__av.act({ ...payload, approval }).reason, 'target_disabled');
  fixture.target.disabled = false;
  fixture.document.elementFromPoint = () => null;
  assert.equal(fixture.window.__av.act({ ...payload, approval }).reason, 'target_obscured');
});

test('visible labels expose hidden native radio semantics and prepare a guarded trusted click without mutation', () => {
  const fixture = styledChoice();
  const node = fixture.window.__av.nodes.find(candidate => candidate.name === '选项B');
  assert.equal(node.role, 'radio');
  assert.equal(node.checked, false);
  assert.equal(node.actions[0].effects[0], 'selection');
  assert.equal(fixture.window.__av.map.get(node.id), fixture.label);
  const plan = fixture.window.__av.act({ name: '选项B', role: 'radio', verb: 'set_checked', checked: true });
  assert.equal(plan.resolved, 'native-choice-label');
  assert.ok(plan.point);
  assert.equal(fixture.native.checked, false);
  assert.equal(fixture.window.__avGuardHit().ok, true);
  fixture.native.checked = true;
  runInContext(createBrowserSource({ currentTab: true }), fixture.context);
  assert.equal(fixture.window.__av.nodes.find(candidate => candidate.role === 'radio').checked, true);
  assert.equal(fixture.window.__av.act({ name: '选项B', role: 'radio', verb: 'set_checked', checked: true }).unchanged, true);
});

test('hidden native choices retain sensitive and disabled guards', () => {
  const sensitive = styledChoice('确认付款');
  assert.equal(sensitive.window.__av.act({ name: '确认付款', verb: 'set_checked', checked: true }).reason, 'sensitive_action');
  assert.equal(sensitive.native.checked, false);
  const disabled = styledChoice();
  disabled.native.disabled = true;
  assert.equal(disabled.window.__av.act({ name: '选项B', verb: 'set_checked', checked: true }).reason, 'target_disabled');
});

test('hidden native choice dispatch rejects reassociation and changed selection', () => {
  const fixture = styledChoice();
  fixture.window.__av.act({ name: '选项B', verb: 'set_checked', checked: true });
  fixture.label.control = { ...fixture.native };
  assert.equal(fixture.window.__avGuardHit().reason, 'stale_check_target');
  fixture.label.control = fixture.native;
  fixture.native.checked = true;
  assert.equal(fixture.window.__avGuardHit().reason, 'stale_check_target');
});

test('trusted practice context is captured and does not treat explanatory choices as deletion', () => {
  const name = 'D.为了清理未使用的import，可以调用编辑器方法自动移除未使用的import语句并进行排序';
  const fixture = styledChoice(name);
  fixture.window.__avPracticeKind = 'practice';
  assert.equal(fixture.window.__av.act({ name, verb: 'set_checked', checked: true }).status, 'needs_user_action');
  runInContext(createBrowserSource({ currentTab: true, practiceKind: 'practice' }), fixture.context);
  assert.equal(fixture.window.__av.act({ name, verb: 'set_checked', checked: true }).ok, true);
});

test('coding textareas expose guarded replacement and exact readback without preparing a synthetic mutation', () => {
  const fixture = page({ tag: 'TEXTAREA', name: '', attributes: { 'aria-label': '代码编辑器' } });
  fixture.target.value = 'old code';
  fixture.target.selectionStart = 0; fixture.target.selectionEnd = 8;
  runInContext(createBrowserSource({ currentTab: true, practiceKind: 'coding' }), fixture.context);
  const plan = fixture.window.__av.act({ name: '代码编辑器', verb: 'set_value', text: 'new code' });
  assert.equal(plan.trusted_text, true);
  assert.equal(fixture.target.value, 'old code');
  assert.equal(fixture.window.__avGuardText('insert').ok, true);
  fixture.document.activeElement = null;
  assert.equal(fixture.window.__avGuardText('insert').reason, 'stale_text_target');
  fixture.target.value = 'new code';
  assert.equal(fixture.window.__av.read({ name: '代码编辑器' }).text, 'new code');
});

test('credential autocomplete blocks writes and keeps sensitive initial text out of all read channels', () => {
  const secret = 'TEST_SECRET_NEVER_RETURN';
  const fixture = page({ tag: 'TEXTAREA', name: secret, attributes: { autocomplete: 'one-time-code' } });
  fixture.target.value = secret;
  fixture.document.body.innerText = '安全提示 ' + secret;
  fixture.document.querySelectorAll = selector => selector === 'input,textarea,select,[contenteditable]' ? [fixture.target] : [];
  runInContext(createBrowserSource({ currentTab: true, practiceKind: 'coding' }), fixture.context);
  const node = fixture.window.__av.nodes.find(candidate => candidate.role === 'textbox');
  assert.equal(node.name.includes(secret), false);
  assert.equal(node.value, undefined);
  assert.equal(fixture.window.__av.act({ id: node.id, verb: 'set_value', text: '123456' }).reason, 'private_input');
  assert.equal(fixture.window.__av.read({ id: node.id }).reason, 'private_input');
  assert.equal(fixture.window.__av.pageText().includes(secret), false);
  assert.equal(JSON.stringify(fixture.window.__av.snapshot).includes(secret), false);
});

test('clipped and virtual-editor proxies have explicit unsupported capabilities instead of native drivers', () => {
  for (const className of ['CodeMirror-input', 'monaco-editor', 'plain-clipped']) {
    const fixture = page({ tag: 'TEXTAREA', name: 'partial proxy', attributes: { 'aria-label': '代码编辑器' } });
    fixture.target.value = 'partial proxy';
    const boundary = { ...fixture.document.body, tagName: 'DIV', className, children: [fixture.target], parentElement: fixture.document.body,
      getBoundingClientRect: () => ({ left: 10, top: 10, width: 0, height: 0 }) };
    fixture.target.parentElement = boundary;
    fixture.document.body.children = [boundary];
    const originalStyle = fixture.context.getComputedStyle;
    fixture.context.getComputedStyle = element => ({ ...originalStyle(element), overflow: element === boundary ? 'hidden' : 'visible' });
    runInContext(createBrowserSource({ currentTab: true, practiceKind: 'coding' }), fixture.context);
    const node = fixture.window.__av.nodes.find(candidate => candidate.role === 'textbox');
    assert.equal(node.editor, undefined);
    assert.equal(node.editor_capability.supported, false);
    assert.equal(node.editor_capability.complete_value, false);
    assert.equal(node.value, undefined);
    assert.equal(fixture.window.__av.read({ id: node.id }).complete_value, false);
    assert.equal(fixture.window.__av.act({ id: node.id, verb: 'set_value', text: 'new code' }).ok, false);
  }
});

test('open-shadow targets use the same deep hit check for preparation and dispatch', () => {
  const fixture = page({ name: '展开', attributes: { 'aria-expanded': 'false' } });
  const host = { ...fixture.document.body, tagName: 'DIV', children: [], parentElement: fixture.document.body };
  const root = { children: [fixture.target], host, elementFromPoint: () => fixture.target };
  host.shadowRoot = root;
  fixture.target.parentElement = null;
  fixture.target.getRootNode = () => root;
  fixture.document.body.children = [host];
  fixture.document.elementFromPoint = () => host;
  runInContext(createBrowserSource({ currentTab: true }), fixture.context);
  assert.equal(fixture.window.__av.act({ name: '展开', verb: 'click' }).ok, true);
  assert.equal(fixture.window.__avGuardHit().ok, true);
  root.elementFromPoint = () => ({ contains: () => false });
  assert.equal(fixture.window.__avGuardHit().reason, 'target_obscured');
});

test('frame limitations report only sanitized origins and never imply complete observation', () => {
  const fixture = page({ tag: 'IFRAME', name: '', attributes: { title: '代码编辑器', src: 'https://user:secret@editor.example/code?token=TOKEN#SECRET' } });
  assert.equal(fixture.window.__av.nodes.length, 0);
  assert.equal(fixture.window.__av.frames[0].origin, 'https://editor.example');
  assert.equal(fixture.window.__av.frames[0].same_origin, false);
  assert.equal(fixture.window.__av.frames[0].observation_complete, false);
  assert.equal(fixture.window.__av.frames[0].actions_supported, false);
  assert.equal(JSON.stringify(fixture.window.__av.frames).includes('secret'), false);
  assert.equal(JSON.stringify(fixture.window.__av.frames).includes('TOKEN'), false);
});

test('proctoring notices require only read-only geometry recovery, not a fake sensitive handoff', () => {
  const fixture = page({ name: '展开' });
  let visible = true;
  const notice = { ...fixture.target, tagName: 'DIV', innerText: '已切屏2次，超过次数将自动交卷',
    getAttribute: () => null, querySelector: () => null, contains: () => false };
  fixture.document.querySelectorAll = selector => selector.includes('[aria-modal=') && visible ? [notice] : [];
  runInContext(createBrowserSource({ currentTab: true, practiceKind: 'practice' }), fixture.context);
  assert.equal(fixture.window.__av.snapshot.dialogs[0].kind, 'proctoring');
  assert.equal(fixture.window.__av.act({ name: '展开', verb: 'click' }).status, 'needs_agent_review');
  assert.equal(fixture.window.__av.act({ name: '展开', verb: 'click' }).reason, 'proctoring_notice_visible');
  visible = false;
  assert.equal(fixture.window.__av.act({ name: '展开', verb: 'click' }).ok, true);
  assert.equal(fixture.clicks(), 0);
});

test('code editing rejects rich-text whitespace conversion instead of changing the page style', () => {
  const fixture = page({ tag: 'DIV', name: '', attributes: { 'aria-label': '代码区' } });
  fixture.target.isContentEditable = true;
  fixture.document.body.isContentEditable = false;
  fixture.target.innerText = 'old code';
  runInContext(createBrowserSource({ currentTab: true, practiceKind: 'coding' }), fixture.context);
  const result = fixture.window.__av.act({ name: '代码区', verb: 'set_value', text: '  indented code' });
  assert.equal(result.reason, 'editor_whitespace_not_preserved');
  assert.equal(fixture.target.innerText, 'old code');
});

test('truncated editor contents cannot satisfy an exact code-readback assertion', () => {
  const fixture = page({ tag: 'TEXTAREA', name: '', attributes: { 'aria-label': '代码编辑器' } });
  fixture.target.value = 'code'.repeat(15000);
  runInContext(createBrowserSource({ currentTab: true, practiceKind: 'coding' }), fixture.context);
  const node = fixture.window.__av.snapshot.nodes.find(node => node.role === 'textbox');
  assert.equal(node.value_truncated, true);
  assert.equal(fixture.window.__avVerifyPage(fixture.window.__av.snapshot, { name: '代码编辑器', value: node.value }).ok, false);
});

test('styled native choices expose visible selection evidence without inventing native checked state', () => {
  const fixture = styledChoice();
  fixture.label.className = 'custom-choice custom-choice-checked';
  runInContext(createBrowserSource({ currentTab: true }), fixture.context);
  const node = fixture.window.__av.snapshot.nodes.find(candidate => candidate.role === 'radio');
  assert.equal(node.checked, false);
  assert.equal(node.states.includes('selected'), true);
  assert.equal(node.selectionEvidence.classSelected, true);
  assert.equal(node.selectionEvidence.classSource, 'dom-heuristic');
  assert.equal(fixture.window.__avVerifyPage(fixture.window.__av.snapshot, { name: '选项B', role: 'radio', selected: true }).ok, true);
});

test('the real extractor blocks sensitive actions before any click or coordinate dispatch', () => {
  const fixture = page({ name: '确认付款' });
  const result = fixture.window.__av.act({ name: '确认付款', verb: 'click' });
  assert.equal(result.status, 'needs_user_action');
  assert.equal(result.point, undefined);
  assert.equal(fixture.clicks(), 0);
});

test('current-tab extraction does not mute user media or attach a media observer', () => {
  const fixture = page({ name: '展开' });
  assert.equal(fixture.play(), fixture.originalPlay);
  assert.equal(fixture.observers(), 0);
  assert.equal(fixture.media.muted, false);
  assert.equal(fixture.media.volume, 1);
});

test('tool-owned pages mute existing media and retain normal playback', () => {
  const fixture = page({ name: '展开', current: false });
  assert.equal(fixture.media.muted, true);
  assert.equal(fixture.media.volume, 0);
  fixture.media.muted = false;
  fixture.media.volume = 1;
  fixture.play().call(fixture.media);
  assert.equal(fixture.media.muted, true);
  assert.equal(fixture.media.volume, 0);
  assert.equal(fixture.media.played, true);
  assert.equal(fixture.media.paused, false);
});

test('tool-owned pages mute dynamically added audio without pausing it', () => {
  const fixture = page({ name: '展开', current: false });
  const media = { nodeType: 1, tagName: 'AUDIO', muted: false, volume: 1, paused: false };
  fixture.addMedia(media);
  assert.equal(media.muted, true);
  assert.equal(media.volume, 0);
  assert.equal(media.paused, false);
});

test('target blank links remain in the user-selected tab', () => {
  const fixture = page({ tag: 'A', name: 'Read article', attributes: { href: 'https://example.com/article', target: '_blank' } });
  const result = fixture.window.__av.act({ name: 'Read article', verb: 'click' });
  assert.equal(result.same_tab_url, 'https://example.com/article');
  assert.equal(result.point, undefined);
  assert.equal(fixture.clicks(), 0);
});

test('captured safety policy cannot be weakened through exposed globals', () => {
  const fixture = page({ name: '确认付款' });
  fixture.window.__avAssessAction = () => ({ ok: true });
  assert.equal(fixture.window.__av.act({ name: '确认付款', verb: 'click' }).reason, 'sensitive_action');
});

test('GET search uses form semantics instead of a field-name whitelist', () => {
  const fixture = page({ tag: 'INPUT', name: '', attributes: { name: 'value' }, formAttributes: { method: 'get', action: '/search.aspx' } });
  const candidates = fixture.window.__av.searchCandidates();
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].name, 'value');
  assert.equal(fixture.window.__av.act({ id: candidates[0].id, verb: 'set_value', text: '不第后赋菊' }).ok, true);
  assert.equal(fixture.window.__av.act({ id: candidates[0].id, verb: 'press_enter' }).key, 'Enter');
  assert.equal(fixture.window.__avGuardKey().ok, true);
  fixture.formAttributes.method = 'post';
  assert.equal(fixture.window.__avGuardKey().reason, 'form_submission');
});

test('search Enter rechecks focus, connection, and sensitive form evidence', () => {
  const fixture = page({ tag: 'INPUT', name: '', attributes: { type: 'search', name: 'value' }, formAttributes: { action: '/search' } });
  fixture.window.__av.act({ name: 'value', verb: 'press_enter' });
  fixture.document.activeElement = null;
  assert.equal(fixture.window.__avGuardKey().status, 'needs_agent_review');
  fixture.document.activeElement = fixture.target;
  fixture.formAttributes.action = '/delete';
  assert.equal(fixture.window.__avGuardKey().status, 'needs_user_action');
});

test('unclassified controls request confirmation while missing and stale nodes require discovery', () => {
  const fixture = page({ name: '陌生按钮' });
  assert.equal(fixture.window.__av.act({ name: '陌生按钮', verb: 'click' }).status, 'needs_user_action');
  assert.equal(fixture.window.__av.act({ name: '找不到', verb: 'click' }).reason, 'no_such_name');
  assert.equal(fixture.window.__av.act({ id: 'missing', verb: 'click' }).reason, 'no_such_node');
  fixture.target.isConnected = false;
  assert.equal(fixture.window.__av.act({ name: '陌生按钮', verb: 'click' }).reason, 'stale_node');
  assert.equal(fixture.clicks(), 0);
});

test('a button with the default submit type outside a form is not a form submission', () => {
  const fixture = page({ name: '更多筛选', attributes: { type: 'submit' } });
  assert.equal(fixture.window.__av.nodes[0].actions[0].effects.includes('form_submit'), false);
  assert.equal(fixture.window.__av.act({ name: '更多筛选', verb: 'click' }).ok, true);
});

test('explicit searchbox controls remain visible in the semantic map', () => {
  const fixture = page({ tag: 'INPUT', name: '', attributes: { role: 'searchbox', name: 'term' } });
  assert.equal(fixture.window.__av.searchCandidates().length, 1);
  assert.equal(fixture.window.__av.act({ name: 'term', verb: 'press_enter' }).key, 'Enter');
});

test('semantic targets never switch to an unrelated occluding element', () => {
  const fixture = page({ name: '展开' });
  fixture.document.elementFromPoint = () => ({ textContent: '删除', closest: () => null });
  const result = fixture.window.__av.act({ name: '展开', verb: 'click' });
  assert.equal(result.reason, 'target_obscured');
  assert.equal(result.point, undefined);
  assert.equal(fixture.clicks(), 0);
});

test('permitted targets scroll inside clipping containers before guarded hit testing', () => {
  const fixture = page({ name: '展开' });
  let scrolled = false;
  fixture.target.scrollIntoView = options => {
    assert.equal(options.block, 'center');
    assert.equal(options.inline, 'nearest');
    scrolled = true;
  };
  fixture.document.elementFromPoint = () => scrolled ? fixture.target : null;
  const result = fixture.window.__av.act({ name: '展开', verb: 'click' });
  assert.equal(result.ok, true);
  assert.equal(scrolled, true);
  assert.equal(fixture.window.__avGuardHit().ok, true);
});

test('sensitive targets are rejected before any automatic scrolling', () => {
  const fixture = page({ name: '确认付款' });
  fixture.target.scrollIntoView = () => assert.fail('must not scroll a rejected action');
  assert.equal(fixture.window.__av.act({ name: '确认付款', verb: 'click' }).status, 'needs_user_action');
});

test('dispatch guard rechecks geometry and live semantic identity', () => {
  const fixture = page({ name: '展开' });
  assert.equal(fixture.window.__av.act({ name: '展开', verb: 'click' }).ok, true);
  fixture.target.getBoundingClientRect = () => ({ left: 100, top: 10, width: 100, height: 40 });
  assert.equal(fixture.window.__avGuardHit().reason, 'target_moved');
  fixture.target.isConnected = false;
  assert.equal(fixture.window.__avGuardHit().reason, 'stale_click_target');
});

test('snapshot revision invalidates previous ids without changing document identity', () => {
  const fixture = page({ name: '展开' });
  const old = fixture.window.__av.nodes[0].id;
  const documentId = fixture.window.__av.snapshot.documentId;
  runInContext(createBrowserSource({ currentTab: true }), fixture.context);
  assert.notEqual(fixture.window.__av.nodes[0].id, old);
  assert.equal(fixture.window.__av.snapshot.documentId, documentId);
  assert.equal(fixture.window.__av.act({ id: old, verb: 'click' }).reason, 'stale_revision');
});

test('ids from another document or tab cannot click or read the new page', () => {
  const first = page({ name: '展开' });
  const second = page({ name: '下一页' });
  const old = first.window.__av.nodes[0].id;
  assert.notEqual(second.window.__av.nodes[0].id, old);
  assert.equal(second.window.__av.act({ id: old, verb: 'click' }).reason, 'stale_document');
  assert.equal(second.window.__av.read({ id: old }).reason, 'stale_document');
});
