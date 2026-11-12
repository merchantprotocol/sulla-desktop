// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

import { MacBuildArchitecture, type MacBuildArch } from './mac-build-architecture';
import { MachOArchitectureReader } from './macho-architecture-audit';

export type PackageHostOS = 'darwin' | 'linux' | 'win32';

/** Immutable description of a complete, actually-built desktop target. */
export class PackageTargetSpec {
  readonly key: string;
  readonly builderPlatform = 'mac' as const;
  readonly artifacts = Object.freeze(['zip'] as const);
  readonly assetHostArch: 'arm64' | 'x86_64';
  readonly guestOS = 'linux' as const;
  readonly guestArch: 'arm64' | 'amd64';
  readonly uname: 'arm64' | 'x86_64';
  readonly nativeDependencyPaths: readonly string[];

  private constructor(readonly os: 'darwin', readonly arch: MacBuildArch) {
    this.key = `${ os }-${ arch }`;
    this.assetHostArch = arch === 'x64' ? 'x86_64' : arch;
    this.uname = this.assetHostArch;
    this.guestArch = arch === 'x64' ? 'amd64' : 'arm64';
    const zigArch = arch === 'x64' ? 'x86_64' : 'aarch64';
    this.nativeDependencyPaths = Object.freeze([
      `node_modules/node-pty/prebuilds/darwin-${ arch }/pty.node`,
      `node_modules/node-pty/prebuilds/darwin-${ arch }/spawn-helper`,
      `node_modules/@napi-rs/xattr-darwin-${ arch }/xattr.darwin-${ arch }.node`,
      `node_modules/sherpa-onnx-darwin-${ arch }/sherpa-onnx.node`,
      `node_modules/sherpa-onnx-node/node_modules/sherpa-onnx-darwin-${ arch }/libonnxruntime.dylib`,
      `node_modules/onnxruntime-node/bin/napi-v6/darwin/${ arch }/onnxruntime_binding.node`,
      `node_modules/posix-node/dist/${ zigArch }-macos.node`,
    ]);
    Object.freeze(this);
  }

  static resolve(os: string, arch: string): PackageTargetSpec {
    if (os !== 'darwin') {
      throw new Error(`Packaging target ${ os }/${ arch } is unsupported: only darwin/x64 and darwin/arm64 have complete runtime, asset, signing, builder, and update-feed integrations.`);
    }
    const parsed = MacBuildArchitecture.parse(arch);

    return new PackageTargetSpec('darwin', parsed.node);
  }
}

export interface PackageTargetFileSystem {
  exists(file: string): boolean;
  read(file: string): string;
  readBinary(file: string): Buffer;
  isExecutable(file: string): boolean;
  write(file: string, data: string): void;
}

export class NodePackageTargetFileSystem implements PackageTargetFileSystem {
  exists(file: string): boolean { return fs.existsSync(file); }
  read(file: string): string { return fs.readFileSync(file, 'utf8'); }
  readBinary(file: string): Buffer { return fs.readFileSync(file); }
  isExecutable(file: string): boolean {
    try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; }
  }
  write(file: string, data: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data, 'utf8');
  }
}

/** Host Mach-O binaries are CPU-audited; shell scripts and Linux guest image files are intentionally excluded. */
export class PackageTargetAssetManifest {
  static readonly hostScripts = Object.freeze([
    'darwin/bin/sulla',
    'darwin/bin/sulla-daemon',
  ] as const);

  static readonly hostMachOBinaries = Object.freeze([
    'darwin/bin/spin',
    'darwin/sulla-runtime/sulla-runtime',
  ] as const);

  static readonly required = Object.freeze([
    'darwin/bin/sulla',
    'darwin/bin/sulla-daemon',
    'darwin/bin/spin',
    'darwin/sulla-runtime/sulla-runtime',
    'darwin/sulla-runtime/guest/vmlinuz',
    'darwin/sulla-runtime/guest/initramfs.img',
    'darwin/sulla-runtime/guest/usr.erofs',
  ] as const);

  static readonly guestImages = Object.freeze([
    'darwin/sulla-runtime/guest/vmlinuz',
    'darwin/sulla-runtime/guest/initramfs.img',
    'darwin/sulla-runtime/guest/usr.erofs',
  ] as const);

  /** Opt-in assets that may be intentionally absent without invalidating the supported host target. */
  static readonly optional = Object.freeze([
    'darwin/audio-driver/BlackHole2ch-0.6.1.pkg',
  ] as const);

  problems(resourcesRoot: string, fileSystem: PackageTargetFileSystem = new NodePackageTargetFileSystem()): string[] {
    return PackageTargetAssetManifest.required
      .filter(asset => !fileSystem.exists(path.join(resourcesRoot, asset)))
      .map(asset => `${ asset } is missing`);
  }

  /** Hash real prepared resources so a marker cannot bless an unrelated/stale asset tree. */
  fingerprint(resourcesRoot: string, fileSystem: PackageTargetFileSystem = new NodePackageTargetFileSystem()): string {
    const hash = createHash('sha256');
    for (const asset of PackageTargetAssetManifest.required) {
      const file = path.join(resourcesRoot, asset);
      if (!fileSystem.exists(file)) continue;
      hash.update(asset).update('\0').update(fileSystem.readBinary(file));
    }
    return hash.digest('hex');
  }
}

/** Required target-specific native modules; presence is checked before and after packing and Mach-O CPU is audited at both boundaries. */
export class PackageTargetNativeDependencyManifest {
  problems(repositoryRoot: string, target: PackageTargetSpec, fileSystem: PackageTargetFileSystem = new NodePackageTargetFileSystem()): string[] {
    return target.nativeDependencyPaths
      .filter(dependency => !fileSystem.exists(path.join(repositoryRoot, dependency)))
      .map(dependency => `${ dependency } is missing for ${ target.key }`);
  }

  /** electron-builder unpacks native modules; checking these concrete output paths catches file-filter omissions. */
  packagedProblems(unpackedNodeModules: string, target: PackageTargetSpec, fileSystem: PackageTargetFileSystem = new NodePackageTargetFileSystem()): string[] {
    return target.nativeDependencyPaths
      .filter(dependency => !fileSystem.exists(path.join(unpackedNodeModules, dependency.replace(/^node_modules\//, ''))))
      .map(dependency => `${ dependency } is missing from packaged asar-unpacked output for ${ target.key }`);
  }
}

export interface PackageTargetBinaryAuditor {
  problems(repositoryRoot: string, resourcesRoot: string, target: PackageTargetSpec): string[];
}

export interface PackageTargetArchitectureReader {
  read(file: string): string[] | null;
}

export interface PackageTargetAssetFetcher {
  fetch(target: PackageTargetSpec): Promise<void>;
}

/** Validates selected target inputs before any packaging configuration is written. */
export class PackageTargetPreparationService {
  private readonly auditor: PackageTargetBinaryAuditor;

  constructor(
    private readonly assets = new PackageTargetAssetManifest(),
    private readonly dependencies = new PackageTargetNativeDependencyManifest(),
    private readonly fileSystem: PackageTargetFileSystem = new NodePackageTargetFileSystem(),
    auditor?: PackageTargetBinaryAuditor,
  ) {
    this.auditor = auditor ?? new PackageTargetNativeBinaryAuditor(undefined, fileSystem);
  }

  problems(repositoryRoot: string, resourcesRoot: string, target: PackageTargetSpec): string[] {
    return [
      ...this.assets.problems(resourcesRoot, this.fileSystem),
      ...this.dependencies.problems(repositoryRoot, target, this.fileSystem),
      ...this.auditor.problems(repositoryRoot, resourcesRoot, target),
    ];
  }

  async prepare(repositoryRoot: string, resourcesRoot: string, target: PackageTargetSpec, fetcher: PackageTargetAssetFetcher): Promise<string[]> {
    await fetcher.fetch(target);
    return this.problems(repositoryRoot, resourcesRoot, target);
  }

  async prepareAndRecord(
    repositoryRoot: string,
    resourcesRoot: string,
    target: PackageTargetSpec,
    fetcher: PackageTargetAssetFetcher,
    provenancePath: string,
    provenance: PackageTargetProvenance,
  ): Promise<string[]> {
    const problems = await this.prepare(repositoryRoot, resourcesRoot, target, fetcher);
    if (problems.length === 0) provenance.write(provenancePath, target, this.fingerprint(resourcesRoot));
    return problems;
  }

  fingerprint(resourcesRoot: string): string { return this.assets.fingerprint(resourcesRoot, this.fileSystem); }
}

/** Native addons must be Mach-O for the chosen CPU; this does not claim Node/Electron ABI compatibility. */
export class PackageTargetNativeBinaryAuditor implements PackageTargetBinaryAuditor {
  constructor(
    private readonly reader: PackageTargetArchitectureReader = new MachOArchitectureReader(),
    private readonly fileSystem: PackageTargetFileSystem = new NodePackageTargetFileSystem(),
  ) {}

  problems(repositoryRoot: string, resourcesRoot: string, target: PackageTargetSpec): string[] {
    const wanted = target.arch === 'x64' ? 'x86_64' : 'arm64';
    const paths = [
      ...target.nativeDependencyPaths.map(relative => [relative, path.join(repositoryRoot, relative)] as const),
      ...PackageTargetAssetManifest.hostMachOBinaries.map(relative => [relative, path.join(resourcesRoot, relative)] as const),
    ];
    const scriptProblems = PackageTargetAssetManifest.hostScripts.flatMap(relative => {
      const file = path.join(resourcesRoot, relative);
      if (!this.fileSystem.exists(file)) return [];
      return this.fileSystem.isExecutable(file) ? [] : [`${ relative } is not executable`];
    });
    return [...scriptProblems, ...paths.flatMap(([relative, file]) => {
      if (!this.fileSystem.exists(file)) return [];
      const archs = this.reader.read(file);
      return !archs ? [`${ relative } is not a recognized Mach-O binary; ABI/binary kind cannot be validated`] :
        archs.includes(wanted) ? [] : [`${ relative } has CPU ${ archs.join('+') }, not ${ wanted }`];
    })];
  }
}

/** Target-bound build provenance prevents a later target switch from trusting another target's marker/cache. */
export class PackageTargetProvenance {
  constructor(private readonly fileSystem: PackageTargetFileSystem = new NodePackageTargetFileSystem()) {}

  write(file: string, target: PackageTargetSpec, assetFingerprint: string): void {
    this.fileSystem.write(file, JSON.stringify({
      schema: 1,
      targetKey: target.key,
      hostOS: target.os,
      hostArch: target.arch,
      assetHostArch: target.assetHostArch,
      guestOS: 'linux',
      guestArch: target.guestArch,
      abiValidation: 'not decoded; Mach-O CPU validation does not prove Node/Electron ABI compatibility',
      assetFingerprint,
    }, null, 2));
  }

  problems(file: string, target: PackageTargetSpec, assetFingerprint: string): string[] {
    if (!this.fileSystem.exists(file)) return ['packaging target provenance is missing'];
    let recorded: Record<string, unknown>;

    try {
      recorded = JSON.parse(this.fileSystem.read(file));
    } catch {
      return ['packaging target provenance is invalid JSON'];
    }
    if (recorded.schema !== 1 || recorded.targetKey !== target.key || recorded.hostOS !== target.os || recorded.hostArch !== target.arch ||
      recorded.assetHostArch !== target.assetHostArch || recorded.guestOS !== 'linux' || recorded.guestArch !== target.guestArch ||
      recorded.assetFingerprint !== assetFingerprint) {
      return [`packaging target provenance does not match ${ target.key }`];
    }

    return [];
  }
}
