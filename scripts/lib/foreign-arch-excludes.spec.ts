// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { matchesGlob } from 'path';

import { describe, expect, it } from 'vitest';

import { ForeignArchExcludes } from './foreign-arch-excludes';

/** Applies the negated globs the way electron-builder does: a path is dropped when any negation matches. */
class PackagedFilter {
  constructor(private readonly negations: string[]) {}

  kept(paths: string[]): string[] {
    const positives = this.negations.map(glob => glob.slice(1));

    return paths.filter(file => !positives.some(glob => matchesGlob(file, glob)));
  }
}

const FOREIGN_ARM64 = [
  'node_modules/node-pty/prebuilds/darwin-arm64/pty.node',
  'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
  'node_modules/@napi-rs/xattr-darwin-arm64/xattr.darwin-arm64.node',
  'node_modules/sherpa-onnx-darwin-arm64/sherpa-onnx.node',
  'node_modules/sherpa-onnx-node/node_modules/sherpa-onnx-darwin-arm64/libonnxruntime.dylib',
  'node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/onnxruntime_binding.node',
  'node_modules/posix-node/dist/aarch64-macos.node',
];
const FOREIGN_X64 = [
  'node_modules/node-pty/prebuilds/darwin-x64/pty.node',
  'node_modules/@napi-rs/xattr-darwin-x64/xattr.darwin-x64.node',
  'node_modules/sherpa-onnx-darwin-x64/sherpa-onnx.node',
  'node_modules/onnxruntime-node/bin/napi-v6/darwin/x64/onnxruntime_binding.node',
  'node_modules/posix-node/dist/x86_64-macos.node',
];
const NEUTRAL = [
  'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
  'node_modules/posix-node/dist/index.js',
  'node_modules/sherpa-onnx-node/sherpa-onnx.js',
  'node_modules/onnxruntime-node/bin/napi-v6/linux/x64/onnxruntime_binding.node',
  'dist/app/main.js',
];

describe('ForeignArchExcludes', () => {
  const excludes = new ForeignArchExcludes();

  // risk: an Intel release shipping arm64 Mach-O files
  it('drops every arm64 native prebuild from an Intel (x64) package and keeps x64 and neutral files', () => {
    const filter = new PackagedFilter(excludes.globsFor('x64'));

    expect(filter.kept([...FOREIGN_ARM64, ...FOREIGN_X64, ...NEUTRAL])).toEqual([...FOREIGN_X64, ...NEUTRAL]);
  });

  // risk: an Apple Silicon release shipping x64 Mach-O files
  it('drops every x64 native prebuild from an arm64 package and keeps arm64 and neutral files', () => {
    const filter = new PackagedFilter(excludes.globsFor('arm64'));

    expect(filter.kept([...FOREIGN_ARM64, ...FOREIGN_X64, ...NEUTRAL])).toEqual([...FOREIGN_ARM64, ...NEUTRAL]);
  });

  it('names the other architecture as foreign', () => {
    expect(excludes.foreignArch('x64')).toBe('arm64');
    expect(excludes.foreignArch('arm64')).toBe('x64');
  });
});
