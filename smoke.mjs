#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resourcePath } from './src/core/paths.mjs';

const files = readdirSync(resourcePath('tests')).filter(filename => filename.endsWith('.test.mjs'));
const child = spawn(process.execPath, ['--test', ...files.map(filename => resourcePath('tests', filename))], { stdio: 'inherit' });
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
