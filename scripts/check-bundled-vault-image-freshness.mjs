#!/usr/bin/env node
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Fails when the bundled sulla-vault image pin predates the last commit that
// changed the Vault image's inputs. The pinned image must be built from a
// commit that contains every change the sulla-vault-image workflow builds
// from. With --registry it also fails when the pinned tag was never published
// to GHCR (the workflow only publishes commits that touch those inputs).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export class ImageGitRepository {
  run(args) {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  }

  // Last commit that touched any of the given paths, reachable from `ref`.
  lastCommitTouching(paths, ref = 'HEAD') {
    const out = this.run(['log', '-1', '--format=%H', ref, '--', ...paths]);
    return out || null;
  }

  // True when `ancestor` is an ancestor of (or equal to) `descendant`.
  isAncestor(ancestor, descendant) {
    try { this.run(['merge-base', '--is-ancestor', ancestor, descendant]); return true } catch { return false }
  }

  commitExists(sha) {
    try { this.run(['cat-file', '-e', `${ sha }^{commit}`]); return true } catch { return false }
  }
}

// Anonymous pull-scope lookups against the GHCR v2 API.
export class GhcrManifestRegistry {
  static origin = 'https://ghcr.io';
  static manifestAccept = [
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.docker.distribution.manifest.v2+json',
  ].join(', ');

  constructor(fetchImpl = globalThis.fetch) {
    this.fetch = fetchImpl;
  }

  // Resolves true when `repository:tag` has a manifest, false on 404.
  async hasTag(repository, tag) {
    const tokenResponse = await this.fetch(`${ GhcrManifestRegistry.origin }/token?scope=repository:${ repository }:pull`);
    if (!tokenResponse.ok) throw new Error(`GHCR token request for ${ repository } failed: HTTP ${ tokenResponse.status }`);
    const { token } = await tokenResponse.json();
    const response = await this.fetch(`${ GhcrManifestRegistry.origin }/v2/${ repository }/manifests/${ tag }`, {
      method:  'HEAD',
      headers: { Authorization: `Bearer ${ token }`, Accept: GhcrManifestRegistry.manifestAccept },
    });
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`GHCR manifest lookup for ${ repository }:${ tag } failed: HTTP ${ response.status }`);
    return true;
  }
}

export class BundledVaultImageFreshnessGuard {
  static manifestPath = 'packaging/bundled-images.yaml';
  static imageRepository = 'merchantprotocol/sulla-vault';
  // Must match the `paths` filter of .github/workflows/sulla-vault-image.yml:
  // a commit touching any of these is the one that gets a sha-<commit> image.
  static inputPaths = [
    'services/sulla-vault',
    'packages/vault-crypto',
    'contracts/server-split',
    'scripts/contracts/write-base-image-metadata.mjs',
    '.github/workflows/sulla-vault-image.yml',
  ];

  constructor(repository = new ImageGitRepository(), readFile = readFileSync, registry = new GhcrManifestRegistry(), log = console.log) {
    this.repository = repository;
    this.readFile = readFile;
    this.registry = registry;
    this.log = log;
  }

  pinnedCommit(manifest) {
    const match = manifest.match(/name:\s*sulla-vault,\s*source:\s*ghcr\.io\/merchantprotocol\/sulla-vault:sha-([0-9a-f]{40})/);
    if (!match) throw new Error('sulla-vault must use an immutable sha-<40 hex> tag');
    return match[1];
  }

  async verify({ checkRegistry = false } = {}) {
    const pinned = this.pinnedCommit(this.readFile(BundledVaultImageFreshnessGuard.manifestPath, 'utf8'));
    if (!this.repository.commitExists(pinned)) throw new Error(`sulla-vault pin ${ pinned.slice(0, 12) } is not a commit in this repository`);
    const lastInput = this.repository.lastCommitTouching(BundledVaultImageFreshnessGuard.inputPaths);
    if (!lastInput) throw new Error('no commits found under the Vault image inputs');
    if (!this.repository.isAncestor(lastInput, pinned)) {
      throw new Error(`sulla-vault image pin ${ pinned.slice(0, 12) } is older than the last Vault input change ${ lastInput.slice(0, 12) }; repin ${ BundledVaultImageFreshnessGuard.manifestPath } to sha-${ lastInput } once its image is published`);
    }
    if (checkRegistry) {
      const tag = `sha-${ pinned }`;
      if (!await this.registry.hasTag(BundledVaultImageFreshnessGuard.imageRepository, tag)) {
        throw new Error(`ghcr.io/${ BundledVaultImageFreshnessGuard.imageRepository }:${ tag } is not published in GHCR; pin a tag the sulla-vault-image workflow actually built (last Vault input change is ${ lastInput.slice(0, 12) })`);
      }
    }
    this.log(`bundled-vault-image-freshness: OK (pin ${ pinned.slice(0, 12) } includes last Vault input change ${ lastInput.slice(0, 12) }${ checkRegistry ? '; tag published in GHCR' : '' })`);
  }
}

if (process.argv[1]?.endsWith('check-bundled-vault-image-freshness.mjs')) {
  new BundledVaultImageFreshnessGuard().verify({ checkRegistry: process.argv.includes('--registry') }).catch((error) => {
    console.error(`bundled-vault-image-freshness: FAILED: ${ error.message }`);
    process.exit(1);
  });
}
