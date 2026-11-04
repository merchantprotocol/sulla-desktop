// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentTestChangeClassifier } from './agent-test-selection.mjs';

const classifier = new AgentTestChangeClassifier();

test('renderer and documentation changes avoid the expensive agent job', () => { // risk: CI budget
  assert.deepEqual(classifier.classify(['docs/testing.md', 'pkg/rancher-desktop/pages/Home.vue']), {
    files: ['docs/testing.md', 'pkg/rancher-desktop/pages/Home.vue'], shouldRun: false, needsBusyBox: false,
  });
});

test('agent production and spec changes run the agent job', () => { // risk: test coverage
  assert.equal(classifier.classify(['pkg/sulla-desktop/agent/services/Example.ts']).shouldRun, true);
  assert.equal(classifier.classify(['pkg/sulla-desktop/agent/tests/Unit/Example.spec.ts']).shouldRun, true);
});

test('shared test infrastructure runs the agent job', () => { // risk: test coverage
  for (const file of ['package.json', 'yarn.lock', 'vitest.agent.config.mts', 'scripts/test-pr.mjs']) {
    assert.equal(classifier.classify([file]).shouldRun, true, file);
  }
});

test('guest disk changes alone request BusyBox setup', () => { // risk: characterization coverage
  assert.equal(classifier.classify(['pkg/sulla-desktop/agent/utils/guestDisk.ts']).needsBusyBox, true);
  assert.equal(classifier.classify(['pkg/sulla-desktop/agent/services/AgentJobService.ts']).needsBusyBox, false);
});

test('duplicate and empty paths are normalized before classification', () => { // risk: deterministic CI selection
  assert.deepEqual(classifier.classify(['', 'docs/a.md', 'docs/a.md']).files, ['docs/a.md']);
});
