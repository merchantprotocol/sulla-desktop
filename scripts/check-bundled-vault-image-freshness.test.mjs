// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';
import { BundledVaultImageFreshnessGuard, GhcrManifestRegistry } from './check-bundled-vault-image-freshness.mjs';

const pinSha = 'a'.repeat(40);
const lastInputSha = 'b'.repeat(40);
const manifest = sha => `- { name: sulla-vault, source: ghcr.io/merchantprotocol/sulla-vault:sha-${ sha } }`;

class FakeRepository {
  constructor({ lastInput = lastInputSha, ancestor = true, existing = [pinSha] } = {}) {
    this.lastInput = lastInput;
    this.ancestor = ancestor;
    this.existing = new Set(existing);
    this.lastQueryPaths = null;
  }

  lastCommitTouching(paths) { this.lastQueryPaths = paths; return this.lastInput }
  isAncestor() { return this.ancestor }
  commitExists(sha) { return this.existing.has(sha) }
}

class FakeRegistry {
  constructor(published = []) { this.published = new Set(published); this.queries = [] }
  async hasTag(repository, tag) { this.queries.push(`${ repository }:${ tag }`); return this.published.has(`${ repository }:${ tag }`) }
}

const silent = () => {};
const guardFor = (repository, manifestText = manifest(pinSha), registry = new FakeRegistry()) =>
  new BundledVaultImageFreshnessGuard(repository, () => manifestText, registry, silent);

test('accepts a pin built from a commit that includes the last Vault input change', async() => { // risk: release integrity
  const repository = new FakeRepository();
  await assert.doesNotReject(() => guardFor(repository).verify());
  assert.deepEqual(repository.lastQueryPaths, [
    'services/sulla-vault',
    'packages/vault-crypto',
    'contracts/server-split',
    'scripts/contracts/write-base-image-metadata.mjs',
    '.github/workflows/sulla-vault-image.yml',
  ]);
});

test('rejects a pin older than the last Vault input change', async() => { // risk: release integrity
  const repository = new FakeRepository({ ancestor: false });
  await assert.rejects(() => guardFor(repository).verify(), /older than the last Vault input change/);
});

test('rejects a pin commit that does not exist in the repository', async() => { // risk: release integrity
  const repository = new FakeRepository({ existing: [] });
  await assert.rejects(() => guardFor(repository).verify(), /is not a commit in this repository/);
});

test('rejects a mutable Vault image tag', async() => { // risk: release integrity
  const guard = guardFor(new FakeRepository(), '- { name: sulla-vault, source: ghcr.io/merchantprotocol/sulla-vault:latest }');
  await assert.rejects(() => guard.verify(), /immutable sha/);
});

test('--registry rejects a fresh pin whose tag was never published to GHCR', async() => { // risk: release integrity (app ships an image that cannot be pulled)
  const registry = new FakeRegistry([]);
  await assert.rejects(() => guardFor(new FakeRepository(), manifest(pinSha), registry).verify({ checkRegistry: true }), /is not published in GHCR/);
  assert.deepEqual(registry.queries, [`merchantprotocol/sulla-vault:sha-${ pinSha }`]);
});

test('--registry accepts a fresh pin whose tag is published', async() => { // risk: release integrity
  const registry = new FakeRegistry([`merchantprotocol/sulla-vault:sha-${ pinSha }`]);
  await assert.doesNotReject(() => guardFor(new FakeRepository(), manifest(pinSha), registry).verify({ checkRegistry: true }));
});

test('without --registry the registry is never queried', async() => { // risk: offline dev checks stay offline
  const registry = new FakeRegistry([]);
  await guardFor(new FakeRepository(), manifest(pinSha), registry).verify();
  assert.deepEqual(registry.queries, []);
});

class FakeFetch {
  constructor(manifestStatus, tokenStatus = 200) { this.manifestStatus = manifestStatus; this.tokenStatus = tokenStatus; this.calls = [] }
  async call(url, init = {}) {
    this.calls.push({ url, init });
    if (url.includes('/token?')) return { ok: this.tokenStatus === 200, status: this.tokenStatus, json: async() => ({ token: 'anon-token' }) };
    return { ok: this.manifestStatus >= 200 && this.manifestStatus < 300, status: this.manifestStatus };
  }
}

test('GHCR client reports a present tag via an authenticated manifest HEAD', async() => { // risk: release integrity
  const fake = new FakeFetch(200);
  assert.equal(await new GhcrManifestRegistry(fake.call.bind(fake)).hasTag('merchantprotocol/sulla-vault', 'sha-x'), true);
  assert.equal(fake.calls[0].url, 'https://ghcr.io/token?scope=repository:merchantprotocol/sulla-vault:pull');
  assert.equal(fake.calls[1].url, 'https://ghcr.io/v2/merchantprotocol/sulla-vault/manifests/sha-x');
  assert.equal(fake.calls[1].init.method, 'HEAD');
  assert.equal(fake.calls[1].init.headers.Authorization, 'Bearer anon-token');
  assert.match(fake.calls[1].init.headers.Accept, /application\/vnd\.oci\.image\.index\.v1\+json/);
});

test('GHCR client reports a missing tag on 404', async() => { // risk: release integrity
  const fake = new FakeFetch(404);
  assert.equal(await new GhcrManifestRegistry(fake.call.bind(fake)).hasTag('merchantprotocol/sulla-vault', 'sha-x'), false);
});

test('GHCR client fails loudly on other registry errors instead of passing', async() => { // risk: release integrity (outage must not read as published)
  await assert.rejects(() => new GhcrManifestRegistry(new FakeFetch(500).call.bind(new FakeFetch(500))).hasTag('r', 't'), /HTTP 500/);
  const badToken = new FakeFetch(200, 403);
  await assert.rejects(() => new GhcrManifestRegistry(badToken.call.bind(badToken)).hasTag('r', 't'), /token request .* HTTP 403/);
});
