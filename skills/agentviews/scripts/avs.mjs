#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const config = join(directory, 'tool-path.json');
const runtime = existsSync(config) ? JSON.parse(readFileSync(config, 'utf8')).runtime : join(directory, '..', '..', '..');
const child = spawn(process.execPath, [join(runtime, 'agentviews.mjs'), ...process.argv.slice(2)], { stdio: 'inherit' });
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code === null ? 1 : code; });
