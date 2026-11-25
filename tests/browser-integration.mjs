import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createBrowserSource } from '../src/browser/source.mjs';
import { evalJs } from '../src/browser/evaluate.mjs';
import { detectBrowsers } from '../src/platform/browser-discovery.mjs';
import { dispatchTrustedText } from '../src/cli/text-input.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const executablePath = process.env.AV_CHROME || detectBrowsers()[0]?.exe;
if (!executablePath) throw new Error('No Chromium executable available for local fixture integration');
const server = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  if (request.url.startsWith('/frame')) {
    response.end('<!doctype html><textarea aria-label="iframe-code">unobserved frame content</textarea>');
    return;
  }
  response.end(`<!doctype html><html><body>
    <form method="get" action="/search"><label for="query">查询</label><input id="query" name="value"><button>搜索</button></form>
    <button id="expand" aria-expanded="false" onclick="this.setAttribute('aria-expanded','true')">展开</button>
    <button id="pay" onclick="window.payments++">确认付款</button>
    <select aria-label="排序"><option value="asc">升序</option><option value="desc">降序</option></select>
    <input type="radio" name="answer" aria-label="选项A">
    <label id="styled-choice"><span style="display:inline-block;width:20px;height:20px;border:1px solid"><input id="styled-input" type="radio" name="styled" style="opacity:0"></span>选项B</label>
    <input type="password" value="DO_NOT_RETURN_CREDENTIAL">
    <input aria-label="Security code" autocomplete="one-time-code" value="DO_NOT_RETURN_OTP">
    <textarea autocomplete="current-password">DO_NOT_RETURN_TEXTAREA_SECRET</textarea>
    <div contenteditable="true" autocomplete="one-time-code" style="white-space:pre-wrap">DO_NOT_RETURN_EDITABLE_SECRET</div>
    <textarea aria-label="代码编辑器" style="width:400px;height:90px">old code</textarea>
    <div contenteditable="true" aria-label="代码区" style="width:400px;min-height:90px;white-space:pre-wrap">old code</div>
    <div class="CodeMirror-input" style="position:relative;width:0;height:0;overflow:hidden"><textarea aria-label="输入代理" style="width:1000px;height:10px">partial proxy</textarea></div>
    <div id="shadow-host"></div>
    <iframe title="独立上下文" src="/frame?token=FRAME_SECRET#private-fragment"></iframe>
    <a href="/delete?help=1" target="_blank">删除账号</a>
    <div role="dialog" aria-label="提示" style="display:none" id="notice"><p>该考试允许切屏3次，您已经切屏2次，超过次数自动交卷。</p><button type="button">确认</button></div>
    <p>${'这是用于本地语义编译验证的长段落。'.repeat(15)}<a href="/article">阅读内容</a></p>
    <script>window.payments=0;document.querySelector('#shadow-host').attachShadow({mode:'open'}).innerHTML='<button aria-expanded="false" onclick="this.ariaExpanded=String(true)">展开影子控件</button><input type="search" aria-label="影子搜索"><textarea aria-label="影子代码" style="width:400px;height:90px">old code</textarea><div contenteditable="true" autocomplete="current-password"><p>DO_NOT_RETURN_SHADOW_EDITABLE_SECRET</p></div>';</script></body></html>`);
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
let browser;
try {
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:' + server.address().port);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  await evalJs(cdp, createBrowserSource({ currentTab: true }));
  assert.equal(await page.evaluate(() => window.__av), undefined);
  await page.evaluate(() => { window.__avAssessAction = () => ({ ok: true }); });
  assert.equal((await evalJs(cdp, '__av.act({name:"确认付款",verb:"click"})', false)).reason, 'sensitive_action');
  assert.equal(await page.evaluate(() => window.payments), 0);
  const paymentRequest = await evalJs(cdp, '__av.act({name:"确认付款",verb:"click"})', false);
  const paymentApproval = { scope: paymentRequest.approval_scope, expires_at: Date.now() + 5000 };
  const paymentPlan = await evalJs(cdp, '__av.act(' + JSON.stringify({ name: '确认付款', verb: 'click', approval: paymentApproval }) + ')', false);
  assert.equal(paymentPlan.ok, true);
  assert.equal((await evalJs(cdp, '__avGuardHit()', false)).ok, true);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: paymentPlan.point[0], y: paymentPlan.point[1], button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: paymentPlan.point[0], y: paymentPlan.point[1], button: 'left', clickCount: 1 });
  assert.equal(await page.evaluate(() => window.payments), 1);
  assert.equal((await evalJs(cdp, '__av.act(' + JSON.stringify({ name: '确认付款', verb: 'click', approval: { ...paymentApproval, expires_at: 0 } }) + ')', false)).ok, false);
  const snapshot = await evalJs(cdp, '__av.snapshot', false);
  assert.equal(JSON.stringify(snapshot).includes('DO_NOT_RETURN_CREDENTIAL'), false);
  assert.equal(JSON.stringify(snapshot).includes('DO_NOT_RETURN_'), false);
  assert.equal(JSON.stringify(snapshot).includes('FRAME_SECRET'), false);
  assert.equal(snapshot.frames[0].origin, 'http://127.0.0.1:' + server.address().port);
  assert.equal(snapshot.frames[0].observation_complete, false);
  assert.equal(snapshot.nodes.some(node => node.name === 'iframe-code'), false);
  assert.equal((await evalJs(cdp, '__av.act({name:"Security code",verb:"set_value",text:"123456"})', false)).reason, 'private_input');
  assert.equal(await page.inputValue('input[autocomplete="one-time-code"]'), 'DO_NOT_RETURN_OTP');
  const otpPayload = { name: 'Security code', verb: 'set_value', text: 'AUTHORIZED_FAKE_OTP' };
  const otpRequest = await evalJs(cdp, '__av.act(' + JSON.stringify(otpPayload) + ')', false);
  const otpResult = await evalJs(cdp, '__av.act(' + JSON.stringify({ ...otpPayload,
    approval: { scope: otpRequest.approval_scope, expires_at: Date.now() + 5000 } }) + ')', false);
  assert.equal(otpResult.ok, true);
  assert.equal(otpResult.value_redacted, true);
  assert.equal(otpResult.value, undefined);
  assert.equal(await page.inputValue('input[autocomplete="one-time-code"]'), 'AUTHORIZED_FAKE_OTP');
  const proxy = snapshot.nodes.find(node => node.name === '输入代理');
  assert.equal(proxy.editor, undefined);
  assert.equal(proxy.editor_capability.supported, false);
  assert.equal((await evalJs(cdp, '__av.read({name:"输入代理"})', false)).complete_value, false);
  assert.equal((await evalJs(cdp, '__av.act({name:"删除账号",verb:"click"})', false)).status, 'needs_user_action');
  assert.ok(snapshot.nodes.some(node => node.name === '阅读内容' && node.actions.length));
  assert.equal(snapshot.nodes.find(node => node.name === '选项A').role, 'radio');
  assert.equal(snapshot.nodes.find(node => node.name === '选项B').role, 'radio');
  const choicePlan = await evalJs(cdp, '__av.act({name:"选项B",role:"radio",verb:"set_checked",checked:true})', false);
  assert.equal(choicePlan.resolved, 'native-choice-label');
  assert.equal(await page.isChecked('#styled-input'), false);
  assert.equal((await evalJs(cdp, '__avGuardHit()', false)).ok, true);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: choicePlan.point[0], y: choicePlan.point[1], button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: choicePlan.point[0], y: choicePlan.point[1], button: 'left', clickCount: 1 });
  assert.equal(await page.isChecked('#styled-input'), true);
  assert.equal(snapshot.nodes.find(node => node.name === '排序').options[1].value, 'desc');
  assert.equal((await evalJs(cdp, '__av.act({name:"查询",verb:"set_value",text:"测试查询"})', false)).ok, true);
  assert.equal(await page.inputValue('#query'), '测试查询');
  await page.evaluate(() => {
    const button = document.querySelector('form button');
    button.setAttribute('formmethod', 'post'); button.setAttribute('formaction', '/delete');
  });
  assert.equal((await evalJs(cdp, '__av.act({name:"搜索",verb:"click"})', false)).reason, 'form_submission');
  assert.equal((await evalJs(cdp, '__av.act({name:"查询",verb:"press_enter"})', false)).reason, 'form_submission');
  await page.evaluate(() => { const button = document.querySelector('form button'); button.removeAttribute('formmethod'); button.removeAttribute('formaction'); });
  assert.equal((await evalJs(cdp, '__av.act({name:"排序",verb:"select",option:"desc"})', false)).value, 'desc');
  assert.equal((await evalJs(cdp, '__av.act({name:"选项A",role:"radio",verb:"set_checked",checked:true})', false)).checked, true);
  const plan = await evalJs(cdp, '__av.act({name:"展开",verb:"click"})', false);
  assert.equal(plan.ok, true);
  assert.equal((await evalJs(cdp, '__avGuardHit()', false)).ok, true);
  const [pointX, pointY] = plan.point;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pointX, y: pointY, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pointX, y: pointY, button: 'left', clickCount: 1 });
  assert.equal(await page.getAttribute('#expand', 'aria-expanded'), 'true');
  const settled = await evalJs(cdp, '__av.settle(4000)', true);
  assert.equal(settled.reason, 'quiet'); assert.ok(settled.settled_ms < 1000);
  await evalJs(cdp, createBrowserSource({ currentTab: true }));
  const observed = await evalJs(cdp, '__av.snapshot', false);
  assert.equal(observed.documentId, snapshot.documentId);
  assert.ok(observed.nodes.some(node => node.name === '选项A' && node.checked));
  const oldId = snapshot.nodes.find(node => node.name === '展开').id;
  assert.equal((await evalJs(cdp, '__av.act(' + JSON.stringify({ id: oldId, verb: 'click' }) + ')', false)).reason, 'stale_revision');
  const shadowPlan = await evalJs(cdp, '__av.act({name:"展开影子控件",verb:"click"})', false);
  assert.equal(shadowPlan.ok, true);
  assert.equal((await evalJs(cdp, '__avGuardHit()', false)).ok, true);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: shadowPlan.point[0], y: shadowPlan.point[1], button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: shadowPlan.point[0], y: shadowPlan.point[1], button: 'left', clickCount: 1 });
  assert.equal(await page.locator('#shadow-host button').getAttribute('aria-expanded'), 'true');
  assert.equal((await evalJs(cdp, '__av.act({name:"影子搜索",verb:"press_enter"})', false)).ok, true);
  assert.equal((await evalJs(cdp, '__avGuardKey()', false)).ok, true);
  const code = 'function solve(value) {\n  return value + "<script>literal only</script>";\n}\n';
  for (const name of ['代码编辑器', '代码区', '影子代码']) {
    await evalJs(cdp, createBrowserSource({ currentTab: true, practiceKind: 'coding' }));
    const prepared = await evalJs(cdp, '__av.act(' + JSON.stringify({ name, verb: 'set_value', text: code }) + ')', false);
    assert.equal(prepared.trusted_text, true);
    const inserted = await dispatchTrustedText(cdp, code);
    assert.equal(inserted.ok, true, JSON.stringify({ name, inserted,
      focus: await page.evaluate(() => ({ tag: document.activeElement.tagName, selectionStart: document.activeElement.selectionStart,
        selectionEnd: document.activeElement.selectionEnd, value: document.activeElement.value, platform: navigator.platform })) }));
    await evalJs(cdp, createBrowserSource({ currentTab: true, practiceKind: 'coding' }));
    assert.equal((await evalJs(cdp, '__av.read(' + JSON.stringify({ name }) + ')', false)).text, code);
    assert.equal((await evalJs(cdp, '__av.snapshot', false)).nodes.find(node => node.name === name).value, code);
  }
  assert.equal(await page.locator('script').count(), 1);
  await page.evaluate(() => { document.querySelector('#notice').style.display = 'block'; });
  await evalJs(cdp, createBrowserSource({ currentTab: true }));
  const notice = (await evalJs(cdp, '__av.snapshot', false)).dialogs[0];
  assert.equal(notice.kind, 'proctoring');
  assert.equal(notice.controls[0].name, '确认');
  await page.reload(); cdp.__contextId = null;
  await evalJs(cdp, createBrowserSource({ currentTab: true }));
  assert.equal((await evalJs(cdp, '__av.act(' + JSON.stringify({ id: oldId, verb: 'click' }) + ')', false)).reason, 'stale_document');
  console.log('Local Chromium integration passed: isolation, guards, reading, typed actions, trusted click, settlement and document identity');
} finally {
  try { await browser?.close(); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
