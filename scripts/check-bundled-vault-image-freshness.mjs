#!/usr/bin/env node
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Fails when the bundled sulla-vault image pin predates the last commit that
// changed the Vault image's inputs. The pinned image must be built from a
// commit that contains every change under services/sulla-vault or
// packages/vault-crypto.

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

export class BundledVaultImageFreshnessGuard {
  static manifestPath = 'packaging/bundled-images.yaml';
  static inputPaths = ['services/sulla-vault', 'packages/vault-crypto'];

  constructor(repository = new ImageGitRepository(), readFile = readFileSync) {
    this.repository = repository;
    this.readFile = readFile;
  }

  pinnedCommit(manifest) {
    const match = manifest.match(/name:\s*sulla-vault,\s*source:\s*ghcr\.io\/merchantprotocol\/sulla-vault:sha-([0-9a-f]{40})/);
    if (!match) throw new Error('sulla-vault must use an immutable sha-<40 hex> tag');
    return match[1];
  }

  verify() {
    const pinned = this.pinnedCommit(this.readFile(BundledVaultImageFreshnessGuard.manifestPath, 'utf8'));
    if (!this.repository.commitExists(pinned)) throw new Error(`sulla-vault pin ${ pinned.slice(0, 12) } is not a commit in this repository`);
    const lastInput = this.repository.lastCommitTouching(BundledVaultImageFreshnessGuard.inputPaths);
    if (!lastInput) throw new Error('no commits found under the Vault image inputs');
    if (!this.repository.isAncestor(lastInput, pinned)) {
      throw new Error(`sulla-vault image pin ${ pinned.slice(0, 12) } is older than the last Vault input change ${ lastInput.slice(0, 12) }; rebuild the image from origin/main and repin ${ BundledVaultImageFreshnessGuard.manifestPath }`);
    }
    console.log(`bundled-vault-image-freshness: OK (pin ${ pinned.slice(0, 12) } includes last Vault input change ${ lastInput.slice(0, 12) })`);
  }
}

if (process.argv[1]?.endsWith('check-bundled-vault-image-freshness.mjs')) new BundledVaultImageFreshnessGuard().verify();
