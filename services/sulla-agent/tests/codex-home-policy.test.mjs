// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CodexHomePolicy } from '../codex-home-policy.mjs';

class CodexFeatureRunner {
  run(_command, args, options) {
    const feature = args.at(-1);
    fs.appendFileSync(path.join(options.env.CODEX_HOME, 'config.toml'), `${ feature } = false\n`);
    return { status: 0, stdout: '', stderr: '' };
  }
}

test('configures plugin features without replacing existing config', () => {
  // risk: disk exhaustion returns if an existing conversation keeps plugins enabled.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-policy-config-'));
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "kept"\n[features]\nmulti_agent = false\n');
  const runner = new CodexFeatureRunner();
  new CodexHomePolicy({ home, run: runner.run.bind(runner) }).configure();
  const config = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
  assert.match(config, /model = "kept"/);
  assert.match(config, /multi_agent = false/);
  assert.match(config, /plugins = false/);
  assert.match(config, /remote_plugin = false/);
});

test('removes only plugin and git temp entries', () => {
  // risk: cleanup must not erase Codex conversation history or SQLite state.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-policy-cleanup-'));
  const temporary = path.join(home, '.tmp');
  for (const name of ['plugins-clone-1', 'plugins', 'git-123', 'sessions']) fs.mkdirSync(path.join(temporary, name), { recursive: true });
  fs.writeFileSync(path.join(temporary, 'history.sqlite'), 'keep');
  fs.writeFileSync(path.join(temporary, 'history.sqlite-wal'), 'keep');
  fs.writeFileSync(path.join(temporary, 'plugins.sync.lock'), 'keep');
  new CodexHomePolicy({ home }).cleanupPluginTemp();
  assert.deepEqual(fs.readdirSync(temporary).sort(), ['history.sqlite', 'history.sqlite-wal', 'plugins.sync.lock', 'sessions']);
});
