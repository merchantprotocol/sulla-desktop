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
      // sherpa-onnx.node resolves its dylibs through @loader_path, so they must sit beside it (yarn hoists the per-arch package).
      `node_modules/sherpa-onnx-darwin-${ arch }/libonnxruntime.dylib`,
      `node_modules/sherpa-onnx-darwin-${ arch }/libsherpa-onnx-c-api.dylib`,
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

export interface RuntimeDirectoryOperations {
  rename(source: string, destination: string): Promise<void>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

/** Replaces the installed runtime with a validated staged one, rolling back on failure and always cleaning staging. */
export class StagedRuntimeInstaller {
  constructor(
    private readonly operations: RuntimeDirectoryOperations = {
      rename: (source, destination) => fs.promises.rename(source, destination),
      remove: target => fs.promises.rm(target, { recursive: true, force: true }),
      exists: async target => fs.promises.access(target).then(() => true, () => false),
    },
  ) {}

  async install(stagedRuntime: string, targetRuntime: string, stageDirectory: string): Promise<void> {
    const operations = this.operations;
    const backup = path.join(stageDirectory, 'previous');
    let movedOld = false;
    let installedNew = false;
    try {
      await operations.rename(targetRuntime, backup).then(() => { movedOld = true; }, error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
      await operations.rename(stagedRuntime, targetRuntime);
      installedNew = true;
    } catch (error) {
      if (movedOld && !installedNew) await operations.rename(backup, targetRuntime);
      throw error;
    } finally {
      // On rollback, backup has been restored and the staging tree can go. On
      // successful install, remove both the old runtime backup and temp tree.
      if (installedNew || !await operations.exists(backup)) await operations.remove(stageDirectory);
    }
  }
}

/** Required runtime files must be real files, not symlinks escaping the artifact tree. */
export class RuntimeArtifactSourceValidator {
  async problems(sourceRoot: string): Promise<string[]> {
    const problems: string[] = [];
    const guest = await fs.promises.lstat(path.join(sourceRoot, 'guest')).catch(() => undefined);
    if (!guest?.isDirectory()) problems.push('guest must be a real directory');
    for (const file of ['sulla-runtime', 'guest/vmlinuz', 'guest/initramfs.img', 'guest/usr.erofs']) {
      const stat = await fs.promises.lstat(path.join(sourceRoot, file)).catch(() => undefined);
      if (!stat?.isFile()) problems.push(`${ file } must be a regular file, not a symlink or missing`);
    }
    return problems;
  }
}

/** Host Mach-O binaries are CPU-audited; shell scripts and Linux guest image files are intentionally excluded. */
export class PackageTargetAssetManifest {
  static readonly hostScripts = Object.freeze([
    'darwin/bin/sulla',
    'darwin/bin/sulla-daemon',
    'darwin/bin/spin',
  ] as const);

  static readonly hostMachOBinaries = Object.freeze([
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

  packagedScriptProblems(resourcesRoot: string, fileSystem: PackageTargetFileSystem = new NodePackageTargetFileSystem()): string[] {
    return PackageTargetAssetManifest.hostScripts.flatMap(script => {
      const file = path.join(resourcesRoot, script);
      return !fileSystem.exists(file) || !fileSystem.isExecutable(file) ? [`${ script } is not executable in packaged output`] : [];
    });
  }

  /** Hash real prepared resources so a marker cannot bless an unrelated/stale asset tree. */
  fingerprint(resourcesRoot: string, fileSystem: PackageTargetFileSystem = new NodePackageTargetFileSystem()): string {
    const hash = createHash('sha256');
    for (const asset of PackageTargetAssetManifest.required) {
      // The runtime is signed after packaging; codesign adds/rewrites its signature.
      // Its selected-CPU policy is audited independently at both build boundaries.
      if (asset === 'darwin/sulla-runtime/sulla-runtime') continue;
      const file = path.join(resourcesRoot, asset);
      if (!fileSystem.exists(file)) continue;
      hash.update(asset).update('\0').update(fileSystem.readBinary(file));
    }
    return hash.digest('hex');
  }

  runtimeFingerprint(resourcesRoot: string, fileSystem: PackageTargetFileSystem = new NodePackageTargetFileSystem()): string {
    const file = path.join(resourcesRoot, PackageTargetAssetManifest.hostMachOBinaries[0]);
    return createHash('sha256').update(fileSystem.readBinary(file)).digest('hex');
  }
}

/** Required target-specific native modules; presence is checked before and after packing and Mach-O CPU is audited at both boundaries. */
export class PackageTargetNativeDependencyManifest {
  /** node-pty 1.1.0 prefers build/Release when install-app-deps produced it, then falls back to prebuilds. */
  static readonly nodePtyRuntimeCandidates = Object.freeze([
    'node_modules/node-pty/build/Release/pty.node',
    'node_modules/node-pty/build/Release/spawn-helper',
    'node_modules/node-pty/prebuilds/darwin-x64/pty.node',
    'node_modules/node-pty/prebuilds/darwin-x64/spawn-helper',
    'node_modules/node-pty/prebuilds/darwin-arm64/pty.node',
    'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
  ] as const);
  problems(repositoryRoot: string, target: PackageTargetSpec, fileSystem: PackageTargetFileSystem = new NodePackageTargetFileSystem()): string[] {
    return target.nativeDependencyPaths
      .filter(dependency => !fileSystem.exists(path.join(repositoryRoot, dependency)))
      .map(dependency => `${ dependency } is missing for ${ target.key }`);
  }

  /** electron-builder unpacks native modules; checking these concrete output paths catches file-filter omissions. */
  packagedProblems(unpackedNodeModules: string, target: PackageTargetSpec, fileSystem: PackageTargetFileSystem = new NodePackageTargetFileSystem()): string[] {
    const problems = target.nativeDependencyPaths
      .filter(dependency => !fileSystem.exists(path.join(unpackedNodeModules, dependency.replace(/^node_modules\//, ''))))
      .map(dependency => `${ dependency } is missing from packaged asar-unpacked output for ${ target.key }`);
    const nodePtyRequired = ['node_modules/node-pty/prebuilds/darwin-' + target.arch + '/pty.node', 'node_modules/node-pty/prebuilds/darwin-' + target.arch + '/spawn-helper'];
    const releaseBinary = path.join(unpackedNodeModules, 'node-pty/build/Release/pty.node');
    const releaseHelper = path.join(unpackedNodeModules, 'node-pty/build/Release/spawn-helper');
    if (fileSystem.exists(releaseBinary) && !fileSystem.exists(releaseHelper)) problems.push('node_modules/node-pty/build/Release/spawn-helper is missing although build/Release/pty.node is present');
    if (fileSystem.exists(releaseBinary) && fileSystem.exists(releaseHelper) && !fileSystem.isExecutable(releaseHelper)) problems.push('node_modules/node-pty/build/Release/spawn-helper is not executable in packaged asar-unpacked output');
    for (const relative of PackageTargetNativeDependencyManifest.nodePtyRuntimeCandidates) {
      const packaged = path.join(unpackedNodeModules, relative.replace(/^node_modules\//, ''));
      if (nodePtyRequired.includes(relative) && !fileSystem.exists(packaged)) problems.push(`${ relative } is missing from packaged asar-unpacked output for ${ target.key }`);
      if (fileSystem.exists(packaged) && relative.endsWith('/spawn-helper') && !fileSystem.isExecutable(packaged)) problems.push(`${ relative } is not executable in packaged asar-unpacked output`);
    }
    return problems;
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
    if (problems.length === 0) provenance.write(provenancePath, target, this.fingerprint(resourcesRoot), this.assets.runtimeFingerprint(resourcesRoot, this.fileSystem));
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
    // MachOArchitectureReader names CPUs with the Node arch ('x64'/'arm64'), not uname values.
    const wanted: string = target.arch;
    const paths = [
      ...target.nativeDependencyPaths.map(relative => [relative, path.join(repositoryRoot, relative)] as const),
      ...['node_modules/node-pty/build/Release/pty.node'].flatMap(relative => {
        const file = path.join(repositoryRoot, relative);
        return this.fileSystem.exists(file) ? [[relative, file] as const] : [];
      }),
      ...PackageTargetAssetManifest.hostMachOBinaries.map(relative => [relative, path.join(resourcesRoot, relative)] as const),
    ];
    const scriptProblems = PackageTargetAssetManifest.hostScripts.flatMap(relative => {
      const file = path.join(resourcesRoot, relative);
      if (!this.fileSystem.exists(file)) return [];
      return this.fileSystem.isExecutable(file) ? [] : [`${ relative } is not executable`];
    });
    const releaseHelper = path.join(repositoryRoot, 'node_modules/node-pty/build/Release/spawn-helper');
    const releaseBinary = path.join(repositoryRoot, 'node_modules/node-pty/build/Release/pty.node');
    if (this.fileSystem.exists(releaseBinary) && !this.fileSystem.isExecutable(releaseHelper)) scriptProblems.push('node_modules/node-pty/build/Release/spawn-helper is not executable');
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

  write(file: string, target: PackageTargetSpec, assetFingerprint: string, runtimeFingerprint = ''): void {
    this.fileSystem.write(file, JSON.stringify({
      schema: 2,
      targetKey: target.key,
      hostOS: target.os,
      hostArch: target.arch,
      assetHostArch: target.assetHostArch,
      guestOS: 'linux',
      guestArch: target.guestArch,
      abiValidation: 'not decoded; Mach-O CPU validation does not prove Node/Electron ABI compatibility',
      assetFingerprint,
      runtimeFingerprint,
    }, null, 2));
  }

  problems(file: string, target: PackageTargetSpec, assetFingerprint: string, runtimeFingerprint?: string): string[] {
    if (!this.fileSystem.exists(file)) return ['packaging target provenance is missing'];
    let recorded: Record<string, unknown>;

    try {
      recorded = JSON.parse(this.fileSystem.read(file));
    } catch {
      return ['packaging target provenance is invalid JSON'];
    }
    if (recorded.schema !== 2 || recorded.targetKey !== target.key || recorded.hostOS !== target.os || recorded.hostArch !== target.arch ||
      recorded.assetHostArch !== target.assetHostArch || recorded.guestOS !== 'linux' || recorded.guestArch !== target.guestArch ||
      recorded.assetFingerprint !== assetFingerprint || (runtimeFingerprint !== undefined && recorded.runtimeFingerprint !== runtimeFingerprint)) {
      return [`packaging target provenance does not match ${ target.key }`];
    }

    return [];
  }
}
