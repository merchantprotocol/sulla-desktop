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

test('the guest-disk characterization spec and its production dependencies request BusyBox setup', () => { // risk: characterization coverage
  assert.equal(classifier.classify(['pkg/sulla-desktop/agent/tests/Characterization/DesktopRuntime/desktopRuntime.spec.ts']).needsBusyBox, true);
  assert.equal(classifier.classify(['src/runtime-agent/datadisk.go']).needsBusyBox, true);
  assert.equal(classifier.classify(['services/sulla-tools/Dockerfile']).needsBusyBox, true);
  assert.equal(classifier.classify(['services/sulla-tools/src/index.ts']).needsBusyBox, false);
});

test('a shared module imported by agent code, outside the agent root, still runs the agent job', () => { // risk: coverage gap — allowlist skipped agent specs when shared code changed
  assert.equal(classifier.classify(['pkg/sulla-desktop/shared/VaultBrokerClient.ts']).shouldRun, true);
  assert.equal(classifier.classify(['pkg/sulla-desktop/vault-broker/VaultBroker.ts']).shouldRun, true);
});

test('a renderer-only Vue/CSS change is known-irrelevant and skips the agent job', () => { // risk: CI budget
  assert.equal(classifier.classify(['pkg/sulla-desktop/components/Example.vue']).shouldRun, false);
  assert.equal(classifier.classify(['pkg/sulla-desktop/assets/styles/example.css']).shouldRun, false);
});

test('an unrelated workflow file is known-irrelevant, but editing this workflow itself still runs the agent job', () => { // risk: fail-safe gate correctness
  assert.equal(classifier.classify(['.github/workflows/release.yml']).shouldRun, false);
  assert.equal(classifier.classify(['.github/workflows/agent-tests.yml']).shouldRun, true);
});

test('an unrecognized file type defaults to running the agent job (fail-safe, not an allowlist)', () => { // risk: coverage gap
  assert.equal(classifier.classify(['pkg/sulla-desktop/main/configureSignedInVaultBroker.ts']).shouldRun, true);
});

test('duplicate and empty paths are normalized before classification', () => { // risk: deterministic CI selection
  assert.deepEqual(classifier.classify(['', 'docs/a.md', 'docs/a.md']).files, ['docs/a.md']);
});
