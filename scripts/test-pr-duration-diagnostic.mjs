// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

class RelatedSpecDurationDiagnostic {
  constructor(privateBase = process.env.TEST_PR_BASE_REF ?? 'origin/main') { this.baseRef = privateBase }
  changedFiles() {
    const mergeBase = execFileSync('git', ['merge-base', this.baseRef, 'HEAD'], { encoding: 'utf8' }).trim();
    return execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMR', mergeBase, '--'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  }
  run() {
    const output = '/tmp/vitest-related-timings.json'; const files = this.changedFiles();
    execFileSync('yarn', ['vitest', 'related', ...files, '--run', '--config', 'vitest.agent.config.mts', '--reporter=json', `--outputFile=${ output }`], { stdio: 'inherit' });
    const report = JSON.parse(readFileSync(output, 'utf8'));
    const timings = (report.testResults ?? []).map(result => ({ name: result.name, duration: Math.max(0, (result.endTime ?? 0) - (result.startTime ?? 0)) })).sort((a, b) => b.duration - a.duration).slice(0, 15);
    for (const timing of timings) console.log(`::warning title=Vitest spec duration::${ timing.duration }ms ${ timing.name }`);
  }
}
new RelatedSpecDurationDiagnostic().run();
