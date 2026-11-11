// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

class ProcessRunner {
  constructor({ spawnProcess = spawn, clock = performance, output = console } = {}) {
    this.spawnProcess = spawnProcess;
    this.clock = clock;
    this.output = output;
  }

  async run(command, args, deadline) {
    const remaining = deadline - this.clock.now();
    if (remaining <= 0) throw new Error('TEST_BUDGET_EXCEEDED');
    await new Promise((resolve, reject) => {
      const child = this.spawnProcess(command, args, { detached: true, stdio: 'inherit' });
      let finished = false;
      const timer = setTimeout(() => {
        if (finished) return;
        try { process.kill(-child.pid, 'SIGTERM') } catch {}
        setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }, 250).unref();
        reject(new Error('TEST_BUDGET_EXCEEDED'));
      }, remaining);
      child.once('error', error => { finished = true; clearTimeout(timer); reject(error) });
      child.once('exit', (code, signal) => {
        finished = true;
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`${ command } exited ${ code ?? signal }`));
      });
    });
  }

  capture(command, args) {
    return new Promise((resolve, reject) => {
      let stdout = '';
      const child = this.spawnProcess(command, args, { stdio: ['ignore', 'pipe', 'inherit'] });
      child.stdout.on('data', chunk => { stdout += chunk });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(`${ command } exited ${ code }`)));
    });
  }
}

class ChangedFileSelector {
  constructor(processRunner, baseRef = process.env.TEST_PR_BASE_REF ?? 'origin/main') {
    this.processRunner = processRunner;
    this.baseRef = baseRef;
  }

  async select() {
    const mergeBase = await this.processRunner.capture('git', ['merge-base', this.baseRef, 'HEAD']);
    const outputs = await Promise.all([
      this.processRunner.capture('git', ['diff', '--name-only', '--diff-filter=ACMR', mergeBase, '--']),
      this.processRunner.capture('git', ['diff', '--name-only', '--diff-filter=ACMR', '--']),
      this.processRunner.capture('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '--']),
    ]);
    return [...new Set(outputs.flatMap(value => value.split('\n')).filter(Boolean))].sort();
  }
}

class PerPrTestRunner {
  static budgetMs = 60_000;
  static smokeSpecs = [
    'pkg/sulla-desktop/agent/tests/Characterization/ModelRouting/modelRouting.spec.ts',
    'pkg/sulla-desktop/agent/tests/Characterization/Workflows/ExtensionHooks.spec.ts',
    'pkg/sulla-desktop/agent/tests/Unit/Repositories/AgentJobRepository.spec.ts',
  ];

  constructor({ processRunner = new ProcessRunner(), selector, clock = performance, output = console } = {}) {
    this.processRunner = processRunner;
    this.selector = selector ?? new ChangedFileSelector(processRunner);
    this.clock = clock;
    this.output = output;
  }

  requiresSmoke(files) {
    return files.some(file => /(^|\/)(package\.json|yarn\.lock|vitest[^/]*|test[^/]*config|scripts\/test-pr\.mjs)$/.test(file)
      || file.includes('/tests/Support/') || file.includes('/test-kit/') || file.includes('/test-utils/'));
  }

  async run() {
    const started = this.clock.now();
    const deadline = started + PerPrTestRunner.budgetMs;
    if (process.env.TEST_PR_CI_DIAGNOSTICS === 'true') process.stdout.write(`::warning title=agent-tests timing::test-pr started ${ new Date().toISOString() }\n`);
    try {
      await this.processRunner.run('node', ['scripts/architecture-guard/guard.mjs'], deadline);
      if (process.env.TEST_PR_CI_DIAGNOSTICS === 'true') process.stdout.write(`::warning title=agent-tests timing::architecture guard ended after ${ (this.clock.now() - started).toFixed(0) }ms\n`);
      const files = await this.selector.select();
      this.output.log(`Changed files (${ files.length }): ${ files.join(', ') || '(none)' }`);
      const proofDelay = Number.parseInt(process.env.TEST_PR_BUDGET_PROOF_DELAY_MS ?? '0', 10);
      if (proofDelay > 0) await this.processRunner.run(process.execPath, ['-e', `setTimeout(() => {}, ${ proofDelay })`], deadline);
      if (files.length > 0) {
        const changedSpecs = files.filter(file => file.endsWith('.spec.ts'));
        const selection = this.requiresSmoke(files)
          ? ['run', '--config', 'vitest.agent.config.mts', ...new Set([...PerPrTestRunner.smokeSpecs, ...changedSpecs])]
          : ['related', ...files, '--run', '--config', 'vitest.agent.config.mts'];
        this.output.log(this.requiresSmoke(files) ? 'Sensitive test infrastructure changed; running the fast smoke set.' : 'Running related specs only.');
        if (process.env.TEST_PR_CI_DIAGNOSTICS === 'true') process.stdout.write(`::warning title=agent-tests timing::vitest started with ${ selection.filter(value => value.endsWith('.spec.ts')).length } explicit specs\n`);
        await this.processRunner.run('yarn', ['vitest', ...selection, ...(process.env.TEST_PR_CI_DIAGNOSTICS === 'true' ? ['--reporter=hanging-process'] : [])], deadline);
      }
      this.output.log(`Per-PR tests completed in ${ ((this.clock.now() - started) / 1_000).toFixed(2) }s (budget: 60s).`);
    } catch (error) {
      if (error instanceof Error && error.message === 'TEST_BUDGET_EXCEEDED') {
        this.output.error("TEST BUDGET EXCEEDED: per-PR tests took >60s — make them faster, don't raise the budget (see ARCHITECTURE-GUARD.md)");
      } else this.output.error(error);
      process.exitCode = error instanceof Error && error.message === 'TEST_BUDGET_EXCEEDED' ? 124 : 1;
    }
  }
}

await new PerPrTestRunner().run();
