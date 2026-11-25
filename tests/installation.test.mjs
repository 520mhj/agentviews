import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installAgentSkills, initialize } from '../src/setup/install.mjs';
import { applicationDataDir } from '../src/platform/browser-discovery.mjs';

test('the installed module keeps a custom runtime and its pairing for follow-up verification', async () => {
  const home = mkdtempSync(join(tmpdir(), 'avs-custom-runtime-'));
  try {
    const installed = installAgentSkills({ home, env: { AV_BRIDGE_PORT: '9445' }, agents: 'universal', installDir: join(home, 'custom runtime 中文') });
    const before = readFileSync(join(installed.runtime, 'bridge-auth.json'), 'utf8');
    const extensionBefore = readFileSync(join(installed.extension_path, 'config.js'), 'utf8');
    const module = await import(pathToFileURL(join(installed.runtime, 'src', 'setup', 'install.mjs')).href);
    const verified = module.installAgentSkills({ home, env: {}, agents: 'universal' });
    assert.equal(verified.runtime, installed.runtime);
    assert.equal(verified.extension_path, installed.extension_path);
    assert.equal(verified.bridge_port, 9445);
    assert.equal(readFileSync(join(installed.runtime, 'bridge-auth.json'), 'utf8'), before);
    assert.equal(readFileSync(join(installed.extension_path, 'config.js'), 'utf8'), extensionBefore);
    assert.equal(existsSync(applicationDataDir({ home, env: {} })), false);
    const ready = await initialize('verify', { installed: verified, install: {},
      ping: async () => ({ extension: 'id', session_id: 'session' }), createTab: async () => ({ id: 'tab' }) });
    assert.equal(ready.status, 'ready');
    assert.equal(ready.runtime, installed.runtime);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('invalid port overrides do not modify an existing installation or create a new one', () => {
  const home = mkdtempSync(join(tmpdir(), 'avs-invalid-port-'));
  try {
    const installed = installAgentSkills({ home, env: {}, agents: 'universal', installDir: join(home, 'runtime') });
    const filenames = ['bridge-auth.json', 'bridge-ext/config.js', '.agentviews-runtime.json', 'mcp-config.json'];
    const before = filenames.map(filename => readFileSync(join(installed.runtime, filename), 'utf8'));
    for (const port of ['abc', '0', '-1', '65536', '1.5']) {
      assert.throws(() => installAgentSkills({ home, env: { AV_BRIDGE_PORT: port }, agents: 'universal', installDir: installed.runtime }), /Invalid bridge port/);
      assert.deepEqual(filenames.map(filename => readFileSync(join(installed.runtime, filename), 'utf8')), before);
    }
    const fresh = join(home, 'fresh-runtime');
    assert.throws(() => installAgentSkills({ home, env: { AV_BRIDGE_PORT: 'abc' }, agents: 'universal', installDir: fresh }), /Invalid bridge port/);
    assert.equal(existsSync(fresh), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('invalid existing credentials are rejected before resource or extension configuration writes', () => {
  const home = mkdtempSync(join(tmpdir(), 'avs-invalid-pairing-'));
  try {
    const installed = installAgentSkills({ home, env: {}, agents: 'universal', installDir: join(home, 'runtime') });
    const credentialsPath = join(installed.runtime, 'bridge-auth.json');
    const credentials = JSON.parse(readFileSync(credentialsPath, 'utf8'));
    const configBefore = readFileSync(join(installed.extension_path, 'config.js'), 'utf8');
    const markerBefore = readFileSync(join(installed.runtime, '.agentviews-runtime.json'), 'utf8');
    for (const value of [{ ...credentials, token: 'invalid' }, { ...credentials, port: '9445' }, { ...credentials, port: 0 }]) {
      writeFileSync(credentialsPath, JSON.stringify(value));
      assert.throws(() => installAgentSkills({ home, env: {}, agents: 'universal', installDir: installed.runtime }), /Invalid bridge (?:pairing|port)/);
      assert.equal(readFileSync(credentialsPath, 'utf8'), JSON.stringify(value));
      assert.equal(readFileSync(join(installed.extension_path, 'config.js'), 'utf8'), configBefore);
      assert.equal(readFileSync(join(installed.runtime, '.agentviews-runtime.json'), 'utf8'), markerBefore);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a failed resource copy does not overwrite the destination extension pairing', () => {
  const home = mkdtempSync(join(tmpdir(), 'avs-copy-pairing-'));
  try {
    const source = installAgentSkills({ home, env: {}, agents: 'universal', installDir: join(home, 'source-runtime') });
    const destination = installAgentSkills({ home, env: {}, agents: 'universal', installDir: join(home, 'destination-runtime') });
    const configPath = join(destination.extension_path, 'config.js');
    const before = readFileSync(configPath, 'utf8');
    rmSync(join(source.runtime, 'docs'), { recursive: true });
    assert.throws(() => installAgentSkills({ home, env: {}, agents: 'universal', source: source.runtime, installDir: destination.runtime }), { code: 'ENOENT' });
    assert.equal(readFileSync(configPath, 'utf8'), before);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('automatic Cline discovery and explicit selection install into its own global skills directory', () => {
  const home = mkdtempSync(join(tmpdir(), 'avs-cline-skills-'));
  try {
    mkdirSync(join(home, '.cline'));
    const installed = installAgentSkills({ home, env: {}, installDir: join(home, 'runtime') });
    const cline = join(home, '.cline', 'skills', 'agentviews');
    const universal = join(home, '.agents', 'skills', 'agentviews');
    assert.deepEqual(new Set(installed.installed_skills), new Set([cline, universal]));
    assert.equal(existsSync(join(cline, 'SKILL.md')), true);
    assert.equal(existsSync(join(cline, 'scripts', 'avs.mjs')), true);
    const explicit = installAgentSkills({ home, env: {}, agents: 'cline', installDir: installed.runtime });
    assert.deepEqual(explicit.installed_skills, [cline]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
