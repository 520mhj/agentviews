import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AvBridge } from '../src/transport/avbridge.mjs';
import { ensureBridgePairing } from '../src/setup/bridge-pairing.mjs';
import { ROOT_DIRECTORY, resourcePath } from '../src/core/paths.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const directory = mkdtempSync(join(process.env.AIDEN_ARTIFACTS_DIR || tmpdir(), 'avs-extension-integration-'));

async function checkExtension(paired) {
  const fixture = join(directory, paired ? 'paired' : 'source');
  const extension = join(fixture, 'bridge-ext');
  mkdirSync(fixture, { recursive: true });
  cpSync(resourcePath('bridge-ext'), extension, { recursive: true });
  const portProbe = await new AvBridge(0, { token: 'a'.repeat(64) }).start();
  const port = portProbe.port;
  portProbe.close();
  const credentials = paired ? ensureBridgePairing(fixture, { port, sourceRoot: ROOT_DIRECTORY }) : { token: 'a'.repeat(64) };
  if (!paired) writeFileSync(join(extension, 'config.js'), 'globalThis.__AV_BRIDGE_CONFIG = ' + JSON.stringify({ token: null, port }) + ';\n');
  const bridge = await new AvBridge(port, { token: credentials.token }).start();
  let context;
  try {
    context = await chromium.launchPersistentContext(join(fixture, 'profile'), {
      channel: 'chromium', headless: true,
      args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension],
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 10000 });
    assert.ok(worker, 'A real MV3 worker must load; ordinary branded Chrome may reject command-line extension loading');
    const configured = await worker.evaluate(() => typeof globalThis.__AV_BRIDGE_CONFIG?.token === 'string');
    assert.equal(configured, paired);
    if (paired) {
      const identity = await bridge.job('ping', {}, 10000);
      assert.match(identity.extension, /^[a-p]{32}$/);
      assert.match(identity.session_id, /^[0-9a-f-]{36}$/i);
      assert.equal(identity.version, '2.0.0');
      assert.ok(bridge.diagnostics().authenticated_requests >= 2);
      assert.equal(bridge.diagnostics().authentication_rejections, 0);
    } else {
      await assert.rejects(bridge.job('ping', {}, 1000), error => error.code === 'AV_BRIDGE_PEER_UNAVAILABLE');
      assert.equal(bridge.diagnostics().received_requests, 0);
    }
    console.log(JSON.stringify({ scenario: paired ? 'installed_paired' : 'source_unpaired', passed: true,
      worker_loaded: true, diagnostics: bridge.diagnostics() }));
  } finally {
    try { await context?.close(); }
    finally { bridge.close(); }
  }
}

await checkExtension(true);
await checkExtension(false);
console.log('Real MV3 integration passed; no user browser, websites or exam actions were used');
