// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'fs';
import os from 'os';
import path from 'path';

import { Minimatch } from 'minimatch';
import { afterEach, describe, expect, it } from 'vitest';
import yaml from 'yaml';

import { EMITTED_NATIVE_DIR, ForeignArchExcludes } from './foreign-arch-excludes';
import { MacBuildArchitecture, type MacBuildArch } from './mac-build-architecture';
import { MachOArchitectureAudit } from './macho-architecture-audit';

const ROOT = path.resolve(__dirname, '..', '..');

/** A real 64-bit thin Mach-O header (magic + cputype) followed by filler. */
class MachOBytes {
  static thin(arch: MacBuildArch): Buffer {
    const header = Buffer.alloc(32);

    header.writeUInt32BE(0xcffaedfe, 0);
    header.writeUInt32LE(arch === 'x64' ? 0x01000007 : 0x0100000c, 4);

    return header;
  }

  static universal(): Buffer {
    const header = Buffer.alloc(48);

    header.writeUInt32BE(0xcafebabe, 0);
    header.writeUInt32BE(2, 4);
    header.writeUInt32BE(0x01000007, 8);
    header.writeUInt32BE(0x0100000c, 28);

    return header;
  }
}

/**
 * electron-builder's file filter (app-builder-lib/out/util/filter.js): the
 * ordered pattern list where a later negation only removes what is already
 * matched, evaluated with minimatch `dot: true`, applied to files only.
 */
class ElectronBuilderFilter {
  private readonly patterns: Minimatch[];

  constructor(patterns: string[]) {
    this.patterns = patterns.map(pattern => new Minimatch(pattern, { dot: true }));
  }

  /** The `files` list electron-builder gets: the real yml, merged like Builder.package(), plus our exclusions. */
  static forPackage(target: MacBuildArch): ElectronBuilderFilter {
    const config = yaml.parse(fs.readFileSync(path.join(ROOT, 'packaging', 'electron-builder.yml'), 'utf-8'));
    const files = [...config.files, ...config.mac.files, ...new ForeignArchExcludes().globsFor(target)]
      .map((pattern: string) => pattern.replace('${platform}', 'darwin'));

    // dist/app is the bundle; node_modules is added by electron-builder's dependency collector.
    return new ElectronBuilderFilter([...files.slice(0, 1), 'node_modules/**/*', ...files.slice(1)]);
  }

  keeps(relative: string): boolean {
    let match = false;

    for (const pattern of this.patterns) {
      if (match !== pattern.negate) continue;
      match = pattern.match(relative);
    }

    return match;
  }
}

/** Builds a minimal on-disk project tree and stages it through the filter. */
class StagedTree {
  readonly source = fs.mkdtempSync(path.join(os.tmpdir(), 'foreign-arch-src-'));
  readonly staged = fs.mkdtempSync(path.join(os.tmpdir(), 'foreign-arch-out-'));

  add(relative: string, content: Buffer | string = 'x'): this {
    const file = path.join(this.source, relative);

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);

    return this;
  }

  stage(filter: ElectronBuilderFilter | null): string[] {
    const kept: string[] = [];

    for (const relative of this.walk(this.source)) {
      if (filter && !filter.keeps(relative)) continue;
      const target = path.join(this.staged, relative);

      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(this.source, relative), target);
      kept.push(relative);
    }

    return kept.sort();
  }

  dispose(): void {
    fs.rmSync(this.source, { recursive: true, force: true });
    fs.rmSync(this.staged, { recursive: true, force: true });
  }

  private walk(directory: string, prefix = ''): string[] {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const relative = prefix ? `${ prefix }/${ entry.name }` : entry.name;

      return entry.isDirectory() ? this.walk(path.join(directory, entry.name), relative) : [relative];
    });
  }
}

/**
 * The tree an `--ignore-platform` install plus a webpack build produces. Every
 * binary carries the real Mach-O header of the CPU its path claims, and the
 * emitted `native/` addons are named the way build-utils' node-loader emits them.
 */
function dualArchTree(): StagedTree {
  const tree = new StagedTree();
  const emitted = EMITTED_NATIVE_DIR;

  for (const arch of ['x64', 'arm64'] as const) {
    const posix = arch === 'x64' ? 'x86_64' : 'aarch64';

    tree
      .add(`node_modules/node-pty/prebuilds/darwin-${ arch }/pty.node`, MachOBytes.thin(arch))
      .add(`node_modules/node-pty/prebuilds/darwin-${ arch }/spawn-helper`, MachOBytes.thin(arch))
      .add(`node_modules/@napi-rs/xattr-darwin-${ arch }/xattr.darwin-${ arch }.node`, MachOBytes.thin(arch))
      .add(`node_modules/sherpa-onnx-darwin-${ arch }/sherpa-onnx.node`, MachOBytes.thin(arch))
      .add(`node_modules/sherpa-onnx-node/node_modules/sherpa-onnx-darwin-${ arch }/libonnxruntime.dylib`, MachOBytes.thin(arch))
      .add(`node_modules/some-app/node_modules/node-pty/prebuilds/darwin-${ arch }/pty.node`, MachOBytes.thin(arch))
      .add(`node_modules/@scope/native/prebuilds/darwin-${ arch }/addon.node`, MachOBytes.thin(arch))
      .add(`node_modules/onnxruntime-node/bin/napi-v6/darwin/${ arch }/onnxruntime_binding.node`, MachOBytes.thin(arch))
      .add(`node_modules/posix-node/dist/${ posix }-macos.node`, MachOBytes.thin(arch))
      .add(`dist/app/${ emitted }/${ posix }-macos.node`, MachOBytes.thin(arch));
  }

  return tree
    // Reachable by a runtime require on either CPU, or not Mach-O at all: always kept.
    .add('node_modules/node-pty/prebuilds/win32-x64/pty.node', 'MZ')
    .add('node_modules/posix-node/dist/index.js', 'require(`./${name}.node`)')
    .add('node_modules/posix-node/dist/x86_64-linux-gnu.node', '\x7fELF')
    .add('node_modules/posix-node/dist/aarch64-linux-gnu.node', '\x7fELF')
    .add('node_modules/better-sqlite3/build/Release/better_sqlite3.node', MachOBytes.universal())
    .add('node_modules/onnxruntime-node/bin/napi-v6/linux/x64/onnxruntime_binding.node', '\x7fELF')
    .add('dist/app/background.js', 'main');
}

describe('packaged tree for one Mac architecture', () => {
  let tree: StagedTree;

  afterEach(() => tree.dispose());

  // risk: an Intel release shipping arm64 Mach-O files (the 1.7.6 recovery found this)
  it('stages an x64 package with no arm64 binary and every x64 and neutral file', () => {
    tree = dualArchTree();
    const kept = tree.stage(ElectronBuilderFilter.forPackage('x64'));

    expect(new MachOArchitectureAudit().problems(tree.staged, 'x64')).toEqual([]);
    expect(kept.filter(file => /darwin-arm64|darwin\/arm64|aarch64-macos/.test(file))).toEqual([]);
    expect(kept).toEqual(expect.arrayContaining([
      'node_modules/node-pty/prebuilds/darwin-x64/pty.node',
      'node_modules/node-pty/prebuilds/darwin-x64/spawn-helper',
      'node_modules/some-app/node_modules/node-pty/prebuilds/darwin-x64/pty.node',
      'node_modules/@scope/native/prebuilds/darwin-x64/addon.node',
      'node_modules/@napi-rs/xattr-darwin-x64/xattr.darwin-x64.node',
      'node_modules/sherpa-onnx-darwin-x64/sherpa-onnx.node',
      'node_modules/onnxruntime-node/bin/napi-v6/darwin/x64/onnxruntime_binding.node',
      'node_modules/posix-node/dist/x86_64-macos.node',
      `dist/app/${ EMITTED_NATIVE_DIR }/x86_64-macos.node`,
    ]));
  });

  // risk: an Apple Silicon release shipping x64 Mach-O files
  it('stages an arm64 package with no x64 binary and every arm64 and neutral file', () => {
    tree = dualArchTree();
    const kept = tree.stage(ElectronBuilderFilter.forPackage('arm64'));

    expect(new MachOArchitectureAudit().problems(tree.staged, 'arm64')).toEqual([]);
    expect(kept.filter(file => /darwin-x64|darwin\/x64|x86_64-macos/.test(file))).toEqual([]);
    expect(kept).toContain(`dist/app/${ EMITTED_NATIVE_DIR }/aarch64-macos.node`);
    expect(kept).toContain('node_modules/node-pty/prebuilds/darwin-arm64/pty.node');
  });

  // risk: removing a binary a runtime require still needs (posix-node resolves ./<arch>-<os>.node by name)
  it('keeps files a runtime require can still reach and the Linux addons posix-node picks by name', () => {
    tree = dualArchTree();
    const kept = tree.stage(ElectronBuilderFilter.forPackage('x64'));

    expect(kept).toEqual(expect.arrayContaining([
      'node_modules/posix-node/dist/index.js',
      'node_modules/posix-node/dist/x86_64-linux-gnu.node',
      'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
      'dist/app/background.js',
    ]));
  });

  // risk: the test itself being unable to see a foreign binary
  it('without the exclusions the same tree would ship foreign binaries (control)', () => {
    tree = dualArchTree();
    tree.stage(null);

    expect(new MachOArchitectureAudit().problems(tree.staged, 'x64').length).toBeGreaterThanOrEqual(8);
  });
});

describe('MachOArchitectureAudit', () => {
  let tree: StagedTree;

  afterEach(() => tree.dispose());

  // risk: stale gitignored fixed-architecture tools and arch-blind hashed webpack assets
  it('reports a stale arm64 tool and a content-hash-named arm64 addon in an x64 tree, regardless of file name', () => {
    tree = new StagedTree()
      .add('resources/darwin/bin/rdctl', MachOBytes.thin('arm64'))
      .add('dist/app/3f9a1c7b2e.node', MachOBytes.thin('arm64'))
      .add('resources/darwin/bin/whisper-cli', MachOBytes.thin('x64'))
      .add('resources/darwin/bin/universal-tool', MachOBytes.universal())
      .add('resources/darwin/bin/sulla', '#!/bin/sh\n');
    tree.stage(null);

    expect(new MachOArchitectureAudit().problems(tree.staged, 'x64')).toEqual([
      'dist/app/3f9a1c7b2e.node is arm64, not x64',
      'resources/darwin/bin/rdctl is arm64, not x64',
    ]);
  });

  it('does not mistake a Java class file for a universal binary', () => {
    tree = new StagedTree().add('Foo.class', Buffer.from('cafebabe00000041', 'hex'));
    tree.stage(null);

    expect(new MachOArchitectureAudit().problems(tree.staged, 'x64')).toEqual([]);
  });
});

describe('MacBuildArchitecture', () => {
  // risk: an unsupported arch silently packaged as arm64
  it('refuses anything but x64 and arm64', () => {
    for (const arch of ['ia32', 'ppc64', 'x86_64', 'arm', '']) {
      expect(() => MacBuildArchitecture.parse(arch)).toThrow(/Unsupported Mac build architecture/);
    }
    expect(() => new ForeignArchExcludes().globsFor('ia32' as MacBuildArch)).toThrow(/Unsupported/);
  });

  it('maps x64 to x86_64 and arm64 to arm64 for the build scripts, and names the other CPU', () => {
    expect(MacBuildArchitecture.parse('x64').uname).toBe('x86_64');
    expect(MacBuildArchitecture.parse('arm64').uname).toBe('arm64');
    expect(MacBuildArchitecture.parse('x64').foreign.node).toBe('arm64');
    expect(MacBuildArchitecture.parse('arm64').foreign.node).toBe('x64');
  });
});
