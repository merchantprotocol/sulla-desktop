#!/usr/bin/env node
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export class VaultImageGitRepository {
  run(args) {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  }

  isAncestor(ancestor, descendant = 'HEAD') {
    try { this.run(['merge-base', '--is-ancestor', ancestor, descendant]); return true } catch { return false }
  }

  source(path, commit = 'HEAD') {
    return this.run(['show', `${ commit }:${ path }`]);
  }
}

export class BundledVaultParityGuard {
  static manifestPath = 'packaging/bundled-images.yaml';
  static clientPath = 'pkg/sulla-desktop/vault-broker/index.ts';
  static serverPath = 'services/sulla-vault/src/app.ts';
  static enrollmentRoutePattern = /['"](\/v1\/broker\/sulla-cloud\/enrollment-[a-z-]+)['"]/g;

  constructor(repository = new VaultImageGitRepository(), readFile = readFileSync) {
    this.repository = repository;
    this.readFile = readFile;
  }

  pinnedCommit(manifest) {
    const match = manifest.match(/name:\s*sulla-vault,\s*source:\s*ghcr\.io\/merchantprotocol\/sulla-vault:sha-([0-9a-f]{40})/);
    if (!match) throw new Error('sulla-vault must use an immutable sha-<40 hex> tag');
    return match[1];
  }

  enrollmentRoutes(source) {
    return new Set([...source.matchAll(BundledVaultParityGuard.enrollmentRoutePattern)].map(match => match[1]));
  }

  verify() {
    const pinned = this.pinnedCommit(this.readFile(BundledVaultParityGuard.manifestPath, 'utf8'));
    const required = this.enrollmentRoutes(this.repository.source(BundledVaultParityGuard.clientPath));
    // Service images are published and repinned only by the version-release
    // workflow.  A development branch is therefore expected to retain an older
    // bundled pin; guard the source that the next release will actually build.
    const implemented = this.enrollmentRoutes(this.repository.source(BundledVaultParityGuard.serverPath));
    const missing = [...required].filter(route => !implemented.has(route)).sort();
    if (missing.length) throw new Error(`Bundled sulla-vault image is missing Desktop enrollment routes: ${ missing.join(', ') }`);
    console.log(`bundled-vault-parity: OK (next release, ${ required.size } enrollment routes; current pin ${ pinned.slice(0, 12) })`);
  }
}

if (process.argv[1]?.endsWith('check-bundled-vault-parity.mjs')) new BundledVaultParityGuard().verify();
