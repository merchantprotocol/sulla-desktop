#!/usr/bin/env node
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export class GitRepository {
  run(args) {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  }

  isAncestor(ancestor, descendant = 'HEAD') {
    try { this.run(['merge-base', '--is-ancestor', ancestor, descendant]); return true } catch { return false }
  }

  commitDistance(ancestor, descendant = 'HEAD') {
    return Number(this.run(['rev-list', '--count', `${ ancestor }..${ descendant }`]));
  }

  manifestNames(commit = 'HEAD') {
    const output = this.run(['grep', '-h', '-E', '^    name:', commit, '--', BundledToolsParityGuard.manifestsRoot]);
    return new Set([...output.matchAll(/name:\s*['\"]([^'\"]+)['\"]/g)].map(match => match[1]));
  }
}

export class BundledToolsParityGuard {
  static maximumCommitLag = 50;
  static manifestPath = 'packaging/bundled-images.yaml';
  static manifestsRoot = 'pkg/sulla-desktop/agent/tools';

  constructor(repository = new GitRepository(), readFile = readFileSync) {
    this.repository = repository;
    this.readFile = readFile;
  }

  pinnedCommit(manifest) {
    const match = manifest.match(/name:\s*sulla-tools,\s*source:\s*ghcr\.io\/merchantprotocol\/sulla-tools:sha-([0-9a-f]{40})/);
    if (!match) throw new Error('sulla-tools must use an immutable sha-<40 hex> tag');
    return match[1];
  }

  verify() {
    const pinned = this.pinnedCommit(this.readFile(BundledToolsParityGuard.manifestPath, 'utf8'));
    if (!this.repository.isAncestor(pinned)) throw new Error(`Bundled sulla-tools commit ${ pinned } is not an ancestor of HEAD`);
    const distance = this.repository.commitDistance(pinned);
    if (distance > BundledToolsParityGuard.maximumCommitLag) {
      throw new Error(`Bundled sulla-tools is ${ distance } commits behind HEAD (maximum ${ BundledToolsParityGuard.maximumCommitLag })`);
    }
    const current = this.repository.manifestNames();
    const bundled = this.repository.manifestNames(pinned);
    const missing = [...current].filter(name => !bundled.has(name)).sort();
    if (missing.length) throw new Error(`Bundled sulla-tools manifests are missing: ${ missing.join(', ') }`);
    console.log(`bundled-tools-parity: OK (${ pinned.slice(0, 12) }, ${ distance } commits behind, ${ current.size } manifest tools)`);
  }
}

if (process.argv[1]?.endsWith('check-bundled-tools-parity.mjs')) new BundledToolsParityGuard().verify();
