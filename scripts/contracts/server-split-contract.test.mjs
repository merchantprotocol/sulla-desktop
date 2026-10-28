import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const read = path => JSON.parse(fs.readFileSync(new URL(path, root), 'utf8'));
const compatibility = read('contracts/server-split/compatibility.example.json');
const digest = /^sha256:[0-9a-f]{64}$/;

test('compatibility example resolves only exact image digests', () => {
  assert.equal(compatibility.schemaVersion, 1);
  assert.match(compatibility.desktopSource.commit, /^[0-9a-f]{40}$/);
  assert.deepEqual(Object.keys(compatibility.packages).sort(), ['@sulla/relay-protocol', '@sulla/runtime-protocol', '@sulla/workflow-engine']);
  for (const image of Object.values(compatibility.images)) {
    assert.match(image.repository, /^ghcr\.io\/merchantprotocol\/sulla-[a-z0-9-]+$/);
    assert.match(image.digest, digest);
    assert.ok(!image.repository.includes('@') && !image.repository.includes(':latest'));
  }
});

test('schemas reject mutable image references by construction', () => {
  for (const schemaName of ['compatibility.schema.json', 'base-image-metadata.schema.json']) {
    const text = fs.readFileSync(new URL(`contracts/server-split/${schemaName}`, root), 'utf8');
    assert.ok(text.includes('sha256:'));
    assert.ok(!text.includes('latest'));
  }
});

test('services consume extracted contract packages rather than legacy paths', () => {
  const serviceFiles = [
    'services/sulla-workflows/src/manager.ts', 'services/sulla-workflows/src/runner.ts', 'services/sulla-workflows/src/config.ts',
    'services/sulla-tools/src/index.ts', 'services/sulla-tools/src/config.ts', 'services/sulla-tools/src/stores.ts',
    'services/sulla-relay/src/relay.ts',
  ];
  const text = serviceFiles.map(path => fs.readFileSync(new URL(path, root), 'utf8')).join('\n');
  assert.ok(!text.includes('pkg/sulla-desktop/agent/workflow'));
  assert.ok(!text.includes('pkg/sulla-desktop/runtime/capabilityToken'));
  assert.ok(!text.includes('pkg/sulla-desktop/runtime/relayProtocol'));
  assert.match(text, /packages\/workflow-engine/);
  assert.match(text, /packages\/runtime-protocol/);
  assert.match(text, /packages\/relay-protocol/);
  assert.ok(!text.includes('pkg/sulla-desktop/runtime/containerRuntime'));
  assert.ok(!text.includes('pkg/sulla-desktop/runtime/desktopExecutor'));
  assert.ok(!text.includes('pkg/sulla-desktop/agent/tools/executionContext'));
  assert.ok(!text.includes('pkg/sulla-desktop/agent/tools/executionTargets'));
});
