import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { isToken } from '../transport/auth.mjs';

function validatePort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid bridge port');
}

function readCredentials(filename, { protect = true } = {}) {
  const entry = lstatSync(filename);
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error('Unsafe bridge credential path');
  const credentials = JSON.parse(readFileSync(filename, 'utf8'));
  if (!credentials || !isToken(credentials.token)) throw new Error('Invalid bridge pairing; do not silently replace credentials');
  if (credentials.port !== undefined) validatePort(credentials.port);
  if (protect) chmodSync(filename, 0o600);
  return credentials;
}

export function validateBridgePairing(runtime, { port } = {}) {
  if (port !== undefined) validatePort(port);
  const filename = join(runtime, 'bridge-auth.json');
  if (existsSync(filename)) readCredentials(filename, { protect: false });
}

export function readBridgeToken(runtime) {
  return readCredentials(join(realpathSync(runtime), 'bridge-auth.json')).token;
}

export function readBridgeConfiguration(runtime) {
  const credentials = readCredentials(join(realpathSync(runtime), 'bridge-auth.json'));
  return { token: credentials.token, port: credentials.port ?? 9335 };
}

export function ensureBridgePairing(runtime, { port, sourceRoot } = {}) {
  validateBridgePairing(runtime, { port });
  const canonical = realpathSync(runtime);
  if (sourceRoot) {
    const distance = relative(realpathSync(sourceRoot), canonical);
    if (!distance || (!isAbsolute(distance) && distance !== '..' && !distance.startsWith('..' + sep))) {
      throw new Error('Private bridge pairing must be installed outside the source checkout');
    }
  }
  const filename = join(canonical, 'bridge-auth.json');
  let credentials;
  if (existsSync(filename)) credentials = readCredentials(filename);
  else {
    let descriptor;
    try {
      descriptor = openSync(filename, 'wx', 0o600);
      credentials = { token: randomBytes(32).toString('hex'), port: port ?? 9335 };
      writeFileSync(descriptor, JSON.stringify(credentials) + '\n');
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      credentials = readCredentials(filename);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
  port = port ?? credentials.port ?? 9335;
  validatePort(port);
  if (credentials.port !== port) {
    credentials.port = port;
    const temporary = filename + '.' + randomUUID() + '.tmp';
    try {
      writeFileSync(temporary, JSON.stringify(credentials), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, filename);
    } finally {
      try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  const extension = join(canonical, 'bridge-ext');
  const extensionEntry = lstatSync(extension);
  if (extensionEntry.isSymbolicLink() || !extensionEntry.isDirectory()) throw new Error('Unsafe installed extension directory');
  const config = join(extension, 'config.js');
  const temporary = join(extension, '.config-' + randomUUID() + '.js');
  try {
    writeFileSync(temporary, 'globalThis.__AV_BRIDGE_CONFIG = ' + JSON.stringify({ token: credentials.token, port }) + ';\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, config);
    chmodSync(config, 0o600);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { token: credentials.token, port, credentialFile: filename, extensionConfig: config };
}
