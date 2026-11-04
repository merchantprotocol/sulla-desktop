#!/usr/bin/env node
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * Rebuilds the vendored @sulla/foundation tarball from a sulla-core git ref.
 *
 * CI in this repo cannot read the private sulla-core repository, so the package is
 * committed as an `npm pack` tarball under vendor/sulla-core/ and referenced from
 * package.json as `file:vendor/sulla-core/sulla-foundation-<version>-<sha>.tgz`.
 *
 * Usage:
 *   node scripts/vendor-sulla-core.mjs <ref> [path-to-sulla-core-clone]
 *     <ref>    a sulla-core tag or commit (e.g. v0.1.0 or origin/main)
 *     clone    defaults to ../sulla-core
 *
 * Afterwards: update the "@sulla/foundation" path in package.json to the printed
 * tarball name, delete the previous tarball, run `yarn install --ignore-scripts`
 * and commit package.json, yarn.lock and the new tarball together.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, createHash, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

class CoreVendor {
  constructor(ref, clone) {
    if (!ref) throw new Error('usage: node scripts/vendor-sulla-core.mjs <ref> [path-to-sulla-core-clone]');
    this.ref = ref;
    this.clone = resolve(clone ?? '../sulla-core');
    this.destination = resolve('vendor/sulla-core');
  }

  run() {
    const sourceCommit = this.git(['rev-parse', `${this.ref}^{commit}`]).trim();
    const shortSha = sourceCommit.slice(0, 7);
    const checkout = mkdtempSync(join(tmpdir(), 'sulla-core-vendor-'));
    const packed = mkdtempSync(join(tmpdir(), 'sulla-core-pack-'));
    this.git(['worktree', 'add', '--detach', checkout, sha]);
    try {
      const packages = [
        { name: '@sulla/foundation', directory: 'foundation', file: `sulla-foundation-0.1.0-${shortSha}.tgz` },
        { name: '@sulla/domain', directory: 'domain', file: `sulla-domain-0.1.0-${shortSha}.tgz` },
      ];
      mkdirSync(this.destination, { recursive: true });
      for (const packageInfo of packages) {
        this.exec('npm', ['run', 'build', '-w', packageInfo.name], checkout);
        const packageDir = join(checkout, 'packages', packageInfo.directory);
        const packDir = mkdtempSync(join(tmpdir(), 'sulla-core-pack-'));
        try {
          this.exec('npm', ['pack', '--pack-destination', packDir], packageDir);
          const [tarball] = readdirSync(packDir).filter((name) => name.endsWith('.tgz'));
          if (!tarball) throw new Error(`npm pack produced no tarball for ${packageInfo.name}`);
          copyFileSync(join(packDir, tarball), join(this.destination, packageInfo.file));
        } finally {
          rmSync(packDir, { recursive: true, force: true });
        }
      }
      const manifest = packages.map(({ name, file }) => ({
        package: name,
        version: '0.1.0',
        sourceCommit,
        file,
        sha256: createHash('sha256').update(readFileSync(join(this.destination, file))).digest('hex'),
      }));
      writeFileSync(join(this.destination, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      console.log(`vendored ${this.ref} (${sourceCommit}) -> ${manifest.map(({ file }) => file).join(', ')}`);
    } finally {
      this.git(['worktree', 'remove', '--force', checkout]);
      rmSync(packed, { recursive: true, force: true });
    }
  }

  git(args) { return execFileSync('git', ['-C', this.clone, ...args], { encoding: 'utf8' }); }

  exec(command, args, cwd) { execFileSync(command, args, { cwd, stdio: 'inherit' }); }
}

new CoreVendor(process.argv[2], process.argv[3]).run();
