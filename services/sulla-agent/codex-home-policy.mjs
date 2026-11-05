// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** Owns Codex feature configuration and disposal of plugin-only temp data. */
export class CodexHomePolicy {
  constructor({
    home = process.env.CODEX_HOME,
    fileSystem = fs,
    pathApi = path,
    run = spawnSync,
  } = {}) {
    if (!home) throw new Error('CODEX_HOME is required');
    this.home = home;
    this.fileSystem = fileSystem;
    this.pathApi = pathApi;
    this.run = run;
  }

  configure() {
    for (const feature of ['plugins', 'remote_plugin']) {
      const result = this.run('codex', ['features', 'disable', feature], {
        env: { ...process.env, CODEX_HOME: this.home },
        encoding: 'utf8',
      });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(`Could not disable Codex ${ feature }: ${ result.stderr || result.stdout || `exit ${ result.status }` }`);
      }
    }
  }

  cleanupPluginTemp() {
    const temporaryRoot = this.pathApi.join(this.home, '.tmp');
    let entries;
    try {
      entries = this.fileSystem.readdirSync(temporaryRoot, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name === 'plugins' || entry.name.startsWith('plugins-clone-') || entry.name.startsWith('git-')) {
        this.fileSystem.rmSync(this.pathApi.join(temporaryRoot, entry.name), { recursive: true, force: true });
      }
    }
  }
}
