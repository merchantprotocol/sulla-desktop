// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { appendFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { AgentTestChangeClassifier } from './agent-test-selection.mjs';

export class GitChangedFileReader {
  constructor({ baseRef, spawn = spawnSync } = {}) {
    this.baseRef = baseRef;
    this.spawn = spawn;
  }

  read() {
    const result = this.spawn('git', ['diff', '--name-only', '--diff-filter=ACMR', `${this.baseRef}...HEAD`], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || `git diff exited ${result.status}`);
    return result.stdout.split('\n').filter(Boolean);
  }
}

export class GitHubOutputWriter {
  constructor({ outputPath = process.env.GITHUB_OUTPUT, append = appendFile } = {}) {
    this.outputPath = outputPath;
    this.append = append;
  }

  async write(classification) {
    if (!this.outputPath) throw new Error('GITHUB_OUTPUT is required');
    await this.append(this.outputPath, `should_run=${classification.shouldRun}\nneeds_busybox=${classification.needsBusyBox}\n`);
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const reader = new GitChangedFileReader({ baseRef: process.env.TEST_PR_BASE_REF ?? 'origin/main' });
  const classification = new AgentTestChangeClassifier().classify(reader.read());
  console.log(`Agent-test relevant changes: ${classification.shouldRun}; files: ${classification.files.join(', ') || '(none)'}`);
  await new GitHubOutputWriter().write(classification);
}
