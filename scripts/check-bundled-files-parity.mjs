#!/usr/bin/env node
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export class FilesImageGitRepository {
  run(args) {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  }

  isAncestor(ancestor, descendant = 'HEAD') {
    try { this.run(['merge-base', '--is-ancestor', ancestor, descendant]); return true } catch { return false }
  }

  migrationNames(commit = 'HEAD') {
    const output = this.run(['ls-tree', '-r', '--name-only', commit, '--', BundledFilesParityGuard.migrationsRoot]);
    return new Set(output.split('\n').filter(Boolean).map(path => path.split('/').at(-1)));
  }
}

export class BundledFilesParityGuard {
  static manifestPath = 'packaging/bundled-images.yaml';
  static migrationsRoot = 'services/sulla-files/migrations';

  constructor(repository = new FilesImageGitRepository(), readFile = readFileSync) {
    this.repository = repository;
    this.readFile = readFile;
  }

  pinnedCommit(manifest) {
    const match = manifest.match(/name:\s*sulla-files,\s*source:\s*ghcr\.io\/merchantprotocol\/sulla-files:sha-([0-9a-f]{40})/);
    if (!match) throw new Error('sulla-files must use an immutable sha-<40 hex> tag');
    return match[1];
  }

  verify() {
    const pinned = this.pinnedCommit(this.readFile(BundledFilesParityGuard.manifestPath, 'utf8'));
    if (!this.repository.isAncestor(pinned)) throw new Error(`Bundled sulla-files commit ${ pinned } is not an ancestor of HEAD`);
    const current = this.repository.migrationNames();
    const bundled = this.repository.migrationNames(pinned);
    const missing = [...current].filter(name => !bundled.has(name)).sort();
    if (missing.length) throw new Error(`Bundled sulla-files image is missing migrations: ${ missing.join(', ') }`);
    console.log(`bundled-files-parity: OK (${ pinned.slice(0, 12) }, ${ current.size } migrations)`);
  }
}

if (process.argv[1]?.endsWith('check-bundled-files-parity.mjs')) new BundledFilesParityGuard().verify();
