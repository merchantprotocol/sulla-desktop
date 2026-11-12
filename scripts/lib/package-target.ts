// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'fs';
import path from 'path';

import { MacBuildArchitecture, type MacBuildArch } from './mac-build-architecture';

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
      `node_modules/@napi-rs/xattr-darwin-${ arch }/xattr.darwin-${ arch }.node`,
      `node_modules/sherpa-onnx-darwin-${ arch }/sherpa-onnx.node`,
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
  write(file: string, data: string): void;
}

export class NodePackageTargetFileSystem implements PackageTargetFileSystem {
  exists(file: string): boolean { return fs.existsSync(file); }
  read(file: string): string { return fs.readFileSync(file, 'utf8'); }
  write(file: string, data: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data, 'utf8');
  }
}

/** Host executables are audited as Mach-O; the Linux guest image files are data and intentionally excluded. */
export class PackageTargetAssetManifest {
  static readonly hostExecutables = Object.freeze([
    'darwin/bin/sulla',
    'darwin/bin/sulla-daemon',
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

  problems(resourcesRoot: string, fileSystem: PackageTargetFileSystem = new NodePackageTargetFileSystem()): string[] {
    return PackageTargetAssetManifest.required
      .filter(asset => !fileSystem.exists(path.join(resourcesRoot, asset)))
      .map(asset => `${ asset } is missing`);
  }
}

/** Required target-specific native modules; the selected files are checked before packaging and their Mach-O CPU is audited post-pack. */
export class PackageTargetNativeDependencyManifest {
  problems(repositoryRoot: string, target: PackageTargetSpec, fileSystem: PackageTargetFileSystem = new NodePackageTargetFileSystem()): string[] {
    return target.nativeDependencyPaths
      .filter(dependency => !fileSystem.exists(path.join(repositoryRoot, dependency)))
      .map(dependency => `${ dependency } is missing for ${ target.key }`);
  }
}

/** Target-bound build provenance prevents a later target switch from trusting another target's marker/cache. */
export class PackageTargetProvenance {
  constructor(private readonly fileSystem: PackageTargetFileSystem = new NodePackageTargetFileSystem()) {}

  write(file: string, target: PackageTargetSpec): void {
    this.fileSystem.write(file, JSON.stringify({
      schema: 1,
      targetKey: target.key,
      hostOS: target.os,
      hostArch: target.arch,
      assetHostArch: target.assetHostArch,
      guestOS: 'linux',
      guestArch: target.guestArch,
      assetCacheKey: `${ target.key }:assets-v1`,
    }, null, 2));
  }

  problems(file: string, target: PackageTargetSpec): string[] {
    if (!this.fileSystem.exists(file)) return ['packaging target provenance is missing'];
    let recorded: Record<string, unknown>;

    try {
      recorded = JSON.parse(this.fileSystem.read(file));
    } catch {
      return ['packaging target provenance is invalid JSON'];
    }
    if (recorded.schema !== 1 || recorded.targetKey !== target.key || recorded.hostOS !== target.os || recorded.hostArch !== target.arch ||
      recorded.assetHostArch !== target.assetHostArch || recorded.guestOS !== 'linux' || recorded.guestArch !== target.guestArch ||
      recorded.assetCacheKey !== `${ target.key }:assets-v1`) {
      return [`packaging target provenance does not match ${ target.key }`];
    }

    return [];
  }
}
