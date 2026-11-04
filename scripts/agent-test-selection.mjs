// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export class AgentTestChangeClassifier {
  constructor({ agentRoot = 'pkg/sulla-desktop/agent/' } = {}) {
    this.agentRoot = agentRoot;
  }

  classify(files) {
    const normalized = [...new Set(files.filter(Boolean))].sort();
    return {
      files: normalized,
      shouldRun: normalized.some(file => this.isAgentRelevant(file)),
      needsBusyBox: normalized.some(file => this.needsGuestDiskCoverage(file)),
    };
  }

  isAgentRelevant(file) {
    return file.startsWith(this.agentRoot)
      || ['package.json', 'yarn.lock', 'vitest.agent.config.mts', 'scripts/test-pr.mjs',
        'scripts/agent-test-selection.mjs', 'scripts/agent-test-selection.test.mjs',
        'scripts/agent-test-ci-gate.mjs', '.github/workflows/agent-tests.yml'].includes(file)
      || file.startsWith('scripts/architecture-guard/');
  }

  needsGuestDiskCoverage(file) {
    return /guestDisk|GuestDisk/.test(file);
  }
}
