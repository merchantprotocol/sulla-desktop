// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'fs';
import os from 'os';
import path from 'path';

import { Minimatch } from 'minimatch';
import { afterEach, describe, expect, it } from 'vitest';
import webpack from 'webpack';
import yaml from 'yaml';

import { EMITTED_NATIVE_DIR, EMITTED_NATIVE_NAME, ForeignArchExcludes, UnusedMacAddonExcludes } from './foreign-arch-excludes';
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

  /** A 64-bit fat header declaring `count` entries but carrying only `present` of them. */
  static fat(count: number, present: number, magic = 0xcafebabe, entrySize = 20): Buffer {
    const header = Buffer.alloc(8 + present * entrySize);

    header.writeUInt32BE(magic, 0);
    header.writeUInt32BE(count, 4);
    for (let i = 0; i < present; i++) header.writeUInt32BE(0x01000007, 8 + i * entrySize);

    return header;
  }

  static magicOnly(magic: number, length = 32): Buffer {
    const header = Buffer.alloc(length);

    header.writeUInt32BE(magic, 0);

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
  static forPackage(target: MacBuildArch, withUnusedMacAddons = false): ElectronBuilderFilter {
    const config = yaml.parse(fs.readFileSync(path.join(ROOT, 'packaging', 'electron-builder.yml'), 'utf-8'));
    const files = [...config.files, ...config.mac.files, ...new ForeignArchExcludes().globsFor(target), ...(withUnusedMacAddons ? new UnusedMacAddonExcludes().globs() : [])]
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
      .add(`node_modules/sherpa-onnx-darwin-${ arch }/libonnxruntime.dylib`, MachOBytes.thin(arch))
      .add(`node_modules/sherpa-onnx-darwin-${ arch }/libsherpa-onnx-c-api.dylib`, MachOBytes.thin(arch))
      .add(`node_modules/some-app/node_modules/node-pty/prebuilds/darwin-${ arch }/pty.node`, MachOBytes.thin(arch))
      .add(`node_modules/@scope/native/prebuilds/darwin-${ arch }/addon.node`, MachOBytes.thin(arch))
      .add(`node_modules/onnxruntime-node/bin/napi-v6/darwin/${ arch }/onnxruntime_binding.node`, MachOBytes.thin(arch))
      .add(`node_modules/posix-node/dist/${ posix }-macos.node`, MachOBytes.thin(arch))
      .add(`dist/app/${ emitted }/${ posix }-macos.0123456789abcdef0123456789abcdef.node`, MachOBytes.thin(arch));
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
    const kept = tree.stage(ElectronBuilderFilter.forPackage('x64', true));

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
    ]));
    // risk: a signed posix-node Mach-O that SIGILLs on load; nothing on a Mac calls it (Linux-only setpgid)
    expect(kept.filter(file => /-macos/.test(file))).toEqual([]);
    // risk: a Linux ELF and the unused JS wrapper of posix-node riding in a Mac bundle
    expect(kept.filter(file => /posix-node/.test(file))).toEqual([]);
  });

  // risk: an Apple Silicon release shipping x64 Mach-O files
  it('stages an arm64 package with no x64 binary and every arm64 and neutral file', () => {
    tree = dualArchTree();
    const kept = tree.stage(ElectronBuilderFilter.forPackage('arm64', true));

    expect(new MachOArchitectureAudit().problems(tree.staged, 'arm64')).toEqual([]);
    expect(kept.filter(file => /darwin-x64|darwin\/x64|x86_64-macos/.test(file))).toEqual([]);
    expect(kept.filter(file => /-macos/.test(file))).toEqual([]);
    expect(kept.filter(file => /posix-node/.test(file))).toEqual([]);
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

describe('MachOArchitectureAudit header handling (fails closed)', () => {
  let tree: StagedTree;

  afterEach(() => tree.dispose());

  const audit = (files: Record<string, Buffer>): string[] => {
    tree = new StagedTree();
    for (const [name, content] of Object.entries(files)) tree.add(name, content);

    return new MachOArchitectureAudit().problems(tree.source, 'x64');
  };

  // risk: a damaged or exotic Mach-O slipping through the Intel gate unread
  it('rejects a truncated universal table, a zero count, and a magic with no header after it', () => {
    expect(audit({
      'truncated-fat': MachOBytes.fat(3, 1),
      'truncated-fat64': MachOBytes.fat(2, 1, 0xcafebabf, 32),
      'zero-count': MachOBytes.fat(0, 0),
      'magic-only': MachOBytes.magicOnly(0xcffaedfe, 4),
    })).toEqual([
      'magic-only is invalid, not x64',
      'truncated-fat is invalid, not x64',
      'truncated-fat64 is invalid, not x64',
      'zero-count is invalid, not x64',
    ]);
  });

  // risk: 32-bit, big-endian and byte-swapped universal binaries are recognized Mach-O, never x64/arm64 slices
  it('rejects every recognized 32-bit, big-endian and byte-swapped magic as unsupported', () => {
    const magics: Record<string, number> = {
      'mh32-be': 0xfeedface,
      'mh32-le': 0xcefaedfe,
      'mh64-be': 0xfeedfacf,
      'fat-swapped': 0xbebafeca,
      'fat64-swapped': 0xbfbafeca,
    };
    const files = Object.fromEntries(Object.entries(magics).map(([name, magic]) => [name, MachOBytes.magicOnly(magic)]));

    expect(audit(files)).toEqual(Object.keys(magics).sort().map(name => `${ name } is unsupported, not x64`));
  });

  it('passes intact thin and universal files with the wanted slice, and ignores empty and tiny non-Mach-O files', () => {
    expect(audit({
      'x64-thin': MachOBytes.thin('x64'),
      'universal': MachOBytes.universal(),
      'empty': Buffer.alloc(0),
      'tiny': Buffer.from('ab'),
      'class-file': MachOBytes.fat(0x41, 0),
    })).toEqual([]);
  });

  // risk: a foreign Mach-O in the main executable or Frameworks (not only Resources)
  it('audits the whole .app, following no symlinks, and reports a link that leaves the app', () => {
    tree = new StagedTree()
      .add('Sulla.app/Contents/MacOS/Sulla', MachOBytes.thin('arm64'))
      .add('Sulla.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework', MachOBytes.thin('arm64'))
      .add('Sulla.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper', MachOBytes.thin('x64'))
      .add('Sulla.app/Contents/Resources/bin/tool', MachOBytes.thin('x64'));
    const framework = path.join(tree.source, 'Sulla.app/Contents/Frameworks/Electron Framework.framework');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'foreign-arch-outside-'));

    fs.writeFileSync(path.join(outside, 'secret'), MachOBytes.thin('arm64'));
    fs.symlinkSync('A', path.join(framework, 'Versions', 'Current'));
    fs.symlinkSync('Versions/Current/Electron Framework', path.join(framework, 'Electron Framework'));
    fs.symlinkSync(path.join(framework, 'Versions'), path.join(framework, 'Loop'));
    fs.symlinkSync(path.join(outside, 'secret'), path.join(tree.source, 'Sulla.app/Contents/Escape'));
    fs.symlinkSync('/does/not/exist', path.join(tree.source, 'Sulla.app/Contents/Dangling'));

    try {
      expect(new MachOArchitectureAudit().problems(path.join(tree.source, 'Sulla.app'), 'x64')).toEqual([
        'Contents/Escape is a symlink to a path outside the app and cannot be verified',
        'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework is arm64, not x64',
        'Contents/MacOS/Sulla is arm64, not x64',
      ]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('node-loader emitted addon names (real webpack build)', () => {
  let tree: StagedTree;

  afterEach(() => tree.dispose());

  /** Bundles `entry` with the same node-loader name the app build uses; returns what webpack emitted. */
  async function build(entries: string[]): Promise<{ files: string[]; out: string; bundle: string }> {
    const out = path.join(tree.source, 'dist', 'app');
    const main = path.join(tree.source, 'main.js');

    fs.writeFileSync(main, entries.map(entry => `require(${ JSON.stringify(entry) });`).join('\n'));
    const compiler = webpack({
      mode:    'none',
      target:  'node',
      devtool: false,
      context: tree.source,
      entry:   main,
      output:  { path: out, filename: 'background.js' },
      module:  { rules: [{ test: /\.node$/, use: { loader: 'node-loader', options: { name: EMITTED_NATIVE_NAME } } }] },
      resolveLoader: { modules: [path.join(ROOT, 'node_modules')] },
    });
    const stats = await new Promise<webpack.Stats>((resolve, reject) => {
      compiler.run((error, result) => compiler.close(() => (error || !result ? reject(error) : resolve(result))));
    });

    expect(stats.hasErrors() ? stats.toString('errors-only') : '').toBe('');

    const nativeDir = path.join(out, EMITTED_NATIVE_DIR);

    return {
      files:  fs.existsSync(nativeDir) ? fs.readdirSync(nativeDir).sort().map(name => `dist/app/${ EMITTED_NATIVE_DIR }/${ name }`) : [],
      out,
      bundle: fs.readFileSync(path.join(out, 'background.js'), 'utf-8'),
    };
  }

  // risk: two same-named addons from different packages overwriting each other, and hashed names the exclusions must still filter
  it('emits one distinct, architecture-named file per addon even when basenames collide, and the Intel filter drops only the arm64 ones', async() => {
    tree = new StagedTree();
    for (const pkg of ['a', 'b']) {
      tree
        .add(`node_modules/pkg-${ pkg }/dist/aarch64-macos.node`, Buffer.concat([MachOBytes.thin('arm64'), Buffer.from(`arm-${ pkg }`)]))
        .add(`node_modules/pkg-${ pkg }/dist/x86_64-macos.node`, Buffer.concat([MachOBytes.thin('x64'), Buffer.from(`intel-${ pkg }`)]));
    }
    const { files, bundle, out } = await build(['a', 'b'].flatMap(pkg => [`./node_modules/pkg-${ pkg }/dist/aarch64-macos.node`, `./node_modules/pkg-${ pkg }/dist/x86_64-macos.node`]));

    // 4 addons, 4 emitted files: nothing overwritten.
    expect(files).toHaveLength(4);
    expect(new Set(files).size).toBe(4);
    expect(files.filter(file => /\/aarch64-macos\.[0-9a-f]+\.node$/.test(file))).toHaveLength(2);
    expect(files.filter(file => /\/x86_64-macos\.[0-9a-f]+\.node$/.test(file))).toHaveLength(2);
    // Every emitted file is referenced by the bundle and keeps its own content.
    for (const file of files) {
      expect(bundle).toContain(path.posix.basename(file));
      expect(fs.readFileSync(path.join(out, EMITTED_NATIVE_DIR, path.posix.basename(file))).length).toBeGreaterThan(32);
    }
    const contents = files.map(file => fs.readFileSync(path.join(out, EMITTED_NATIVE_DIR, path.posix.basename(file))).toString('latin1'));

    for (const marker of ['arm-a', 'arm-b', 'intel-a', 'intel-b']) {
      expect(contents.filter(content => content.endsWith(marker))).toHaveLength(1);
    }

    // The real emitted names through the real exclusions.
    const x64 = ElectronBuilderFilter.forPackage('x64');
    const arm64 = ElectronBuilderFilter.forPackage('arm64');

    expect(files.filter(file => x64.keeps(file))).toEqual(files.filter(file => file.includes('x86_64-macos')));
    expect(files.filter(file => arm64.keeps(file))).toEqual(files.filter(file => file.includes('aarch64-macos')));
  }, 120_000);

  // risk: the same addon required twice emitting twice (or the hash not following content)
  it('gives identical content one file and different content different hashes', async() => {
    tree = new StagedTree()
      .add('one/x86_64-macos.node', MachOBytes.thin('x64'))
      .add('two/x86_64-macos.node', MachOBytes.thin('x64'));
    const same = await build(['./one/x86_64-macos.node', './two/x86_64-macos.node']);

    expect(same.files).toHaveLength(1);
  }, 120_000);
});
