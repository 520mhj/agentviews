import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBrowserSource } from '../src/browser/source.mjs';
import { evalJs } from '../src/browser/evaluate.mjs';
import { detectBrowsers } from '../src/platform/browser-discovery.mjs';
import { prepareFileSelection, fileSelectionSummary } from '../src/core/file-selection.mjs';
import { dispatchFileUpload } from '../src/cli/file-upload.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const directory = mkdtempSync(join(tmpdir(), 'avs-upload-integration-'));
mkdirSync(join(directory, 'src'));
writeFileSync(join(directory, 'src', 'index.mjs'), 'export const value = 1;');
writeFileSync(join(directory, '.gitignore'), 'node_modules/');
const server = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><html><body><div data-dropzone style="width:500px;height:160px;border:1px solid">
    <p>Drag files here</p><input type="file" multiple aria-label="Choose files">
    </div><script>window.received=[];window.trusted=false;const zone=document.querySelector('[data-dropzone]');
    zone.addEventListener('dragover',event=>event.preventDefault());
    zone.addEventListener('drop',async event=>{event.preventDefault();window.trusted=event.isTrusted;
      const read=async(entry,prefix='')=>{if(entry.isFile){const file=await new Promise(resolve=>entry.file(resolve));window.received.push({name:prefix+file.name,text:await file.text()});}
      else if(entry.isDirectory){const reader=entry.createReader();let batch;do{batch=await new Promise(resolve=>reader.readEntries(resolve));for(const child of batch)await read(child,prefix+entry.name+'/');}while(batch.length);}};
      const entries=Array.from(event.dataTransfer.items,item=>item.webkitGetAsEntry());for(const entry of entries)await read(entry);});
    </script></body></html>`);
});
let browser;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ executablePath: process.env.AV_CHROME || detectBrowsers()[0]?.exe, headless: true });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:' + server.address().port);
  const cdp = await page.context().newCDPSession(page);
  await evalJs(cdp, createBrowserSource({ currentTab: true }));
  const selection = prepareFileSelection([join(directory, 'src'), join(directory, '.gitignore')]);
  const payload = { name: 'Choose files', role: 'fileinput', verb: 'upload_files', upload_mode: 'drop', files: fileSelectionSummary(selection) };
  const request = await evalJs(cdp, '__av.act(' + JSON.stringify(payload) + ')', false);
  assert.equal(request.reason, 'file_upload');
  assert.equal((await page.evaluate(() => window.received)).length, 0);
  const approved = { ...payload, approval: { scope: request.approval_scope, expires_at: Date.now() + 5000 } };
  const plan = await evalJs(cdp, '__av.act(' + JSON.stringify(approved) + ')', false);
  assert.equal(plan.ok, true);
  const result = await dispatchFileUpload(cdp, selection, plan.file_upload);
  assert.equal(result.ok, true);
  await page.waitForFunction(() => window.received.length === 2, null, { timeout: 5000 });
  assert.equal(await page.evaluate(() => window.trusted), true);
  const received = await page.evaluate(() => window.received.sort((first, second) => first.name.localeCompare(second.name)));
  assert.deepEqual(received.map(file => file.name), ['.gitignore', 'src/index.mjs']);
  assert.equal(received.find(file => file.name === 'src/index.mjs').text, 'export const value = 1;');
  await evalJs(cdp, createBrowserSource({ currentTab: true }));
  const nativeSelection = prepareFileSelection([join(directory, '.gitignore')]);
  const nativePayload = { ...payload, upload_mode: 'input', files: fileSelectionSummary(nativeSelection) };
  const nativeRequest = await evalJs(cdp, '__av.act(' + JSON.stringify(nativePayload) + ')', false);
  const nativePlan = await evalJs(cdp, '__av.act(' + JSON.stringify({ ...nativePayload,
    approval: { scope: nativeRequest.approval_scope, expires_at: Date.now() + 5000 } }) + ')', false);
  assert.equal((await dispatchFileUpload(cdp, nativeSelection, nativePlan.file_upload)).ok, true);
  assert.equal(await page.locator('input[type=file]').evaluate(element => element.files[0].name), '.gitignore');
  console.log('Local upload integration passed: scoped consent, trusted directory drag, relative names, exact bytes and native file selection.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  rmSync(directory, { recursive: true, force: true });
}
