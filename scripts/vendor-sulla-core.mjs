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
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

class FoundationVendor {
  constructor(ref, clone) {
    if (!ref) throw new Error('usage: node scripts/vendor-sulla-core.mjs <ref> [path-to-sulla-core-clone]');
    this.ref = ref;
    this.clone = resolve(clone ?? '../sulla-core');
    this.destination = resolve('vendor/sulla-core');
  }

  run() {
    const sha = this.git(['rev-parse', '--short=7', `${this.ref}^{commit}`]).trim();
    const checkout = mkdtempSync(join(tmpdir(), 'sulla-core-vendor-'));
    const packed = mkdtempSync(join(tmpdir(), 'sulla-core-pack-'));
    this.git(['worktree', 'add', '--detach', checkout, sha]);
    try {
      this.exec('npm', ['ci', '--ignore-scripts'], checkout);
      this.exec('npm', ['run', 'build', '-w', '@sulla/foundation'], checkout);
      this.exec('npm', ['pack', '--pack-destination', packed], join(checkout, 'packages/foundation'));
      const [tarball] = readdirSync(packed).filter((name) => name.endsWith('.tgz'));
      if (!tarball) throw new Error('npm pack produced no tarball');
      const name = tarball.replace(/\.tgz$/, `-${sha}.tgz`);
      mkdirSync(this.destination, { recursive: true });
      copyFileSync(join(packed, tarball), join(this.destination, name)); // rename fails across filesystems (EXDEV)
      console.log(`vendored ${this.ref} (${sha}) -> vendor/sulla-core/${name}`);
    } finally {
      this.git(['worktree', 'remove', '--force', checkout]);
      rmSync(packed, { recursive: true, force: true });
    }
  }

  git(args) { return execFileSync('git', ['-C', this.clone, ...args], { encoding: 'utf8' }); }

  exec(command, args, cwd) { execFileSync(command, args, { cwd, stdio: 'inherit' }); }
}

new FoundationVendor(process.argv[2], process.argv[3]).run();
