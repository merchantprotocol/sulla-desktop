// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import path from 'node:path';

// Temporary CI diagnostic: report the active and completed Vitest module durations before the hard PR timeout.
export default class TestPrDurationReporter {
  pending = new Map();
  timer = null;

  onTestRunStart(specifications) {
    for (const specification of specifications) {
      const file = path.relative(process.cwd(), specification.moduleId).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
      this.pending.set(specification.moduleId, { file, started: Date.now() });
    }
    process.stdout.write(`::warning title=Vitest diagnostic::Test run started with ${this.pending.size} selected modules.\n`);
    this.timer = setInterval(() => {
      const running = this.pending.values().next().value;
      if (running) process.stdout.write(`::warning file=${running.file},title=Vitest active spec duration::queued/running for ${Date.now() - running.started}ms\n`);
    }, 5_000);
  }

  onTestModuleQueued(module) {
    const pending = this.pending.get(module.moduleId);
    if (pending) process.stdout.write(`::warning file=${pending.file},title=Vitest spec queued::${pending.file} queued for execution.\n`);
  }

  onTestModuleCollected(module) {
    const pending = this.pending.get(module.moduleId);
    if (pending) {
      process.stdout.write(`::warning file=${pending.file},title=Vitest collection duration::collected after ${Date.now() - pending.started}ms.\n`);
      pending.started = Date.now();
    }
  }

  onTestModuleStart(module) {
    const pending = this.pending.get(module.moduleId);
    if (pending) pending.started = Date.now();
  }

  onTestRunEnd() {
    const running = this.pending.values().next().value;
    if (running) process.stdout.write(`::warning file=${running.file},title=Vitest active spec duration::run ended with ${Date.now() - running.started}ms elapsed and ${this.pending.size} modules pending.\n`);
    if (this.timer) clearInterval(this.timer);
  }

  onTestModuleEnd(module) {
    const pending = this.pending.get(module.moduleId);
    this.pending.delete(module.moduleId);
    const file = pending?.file ?? module.relativeModuleId;
    const duration = module.diagnostic().duration;
    process.stdout.write(`::warning file=${file},title=Vitest per-file duration::${duration.toFixed(0)}ms (${module.state()})\n`);
    if (!this.pending.size && this.timer) clearInterval(this.timer);
  }
}
