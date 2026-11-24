#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later

const { spawn } = require('node:child_process');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const root = path.resolve(__dirname, '../..');
const vite = path.join(root, 'node_modules/.bin/vite');
const child = spawn(vite, ['--config', path.join(__dirname, 'vite.config.mts')], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
});
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
