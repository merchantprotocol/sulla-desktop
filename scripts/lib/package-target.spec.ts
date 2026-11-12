// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import {
  PackageTargetAssetManifest,
  PackageTargetNativeDependencyManifest,
  PackageTargetProvenance,
  PackageTargetSpec,
  type PackageTargetFileSystem,
} from './package-target';

class MemoryFileSystem implements PackageTargetFileSystem {
  readonly files = new Map<string, string>();
  exists(file: string): boolean { return this.files.has(file); }
  read(file: string): string { return this.files.get(file) ?? ''; }
  write(file: string, data: string): void { this.files.set(file, data); }
}

describe('package target integrity', () => {
  it('accepts only built macOS CPU targets and maps host, guest, builder, and artifact values', () => {
    // risk: packaging integrity — prevents publishing artifacts for an unbuilt OS/CPU combination.
    const x64 = PackageTargetSpec.resolve('darwin', 'x64');
    const arm64 = PackageTargetSpec.resolve('darwin', 'arm64');

    expect([x64.key, x64.assetHostArch, x64.guestOS, x64.guestArch, x64.builderPlatform, x64.artifacts]).toEqual([
      'darwin-x64', 'x86_64', 'linux', 'amd64', 'mac', ['zip'],
    ]);
    expect([arm64.key, arm64.assetHostArch, arm64.guestOS, arm64.guestArch]).toEqual(['darwin-arm64', 'arm64', 'linux', 'arm64']);
    expect(() => PackageTargetSpec.resolve('linux', 'x64')).toThrow(/unsupported/);
    expect(() => PackageTargetSpec.resolve('win32', 'arm64')).toThrow(/unsupported/);
    expect(() => PackageTargetSpec.resolve('darwin', 'ia32')).toThrow(/only x64 and arm64/);
  });

  it('requires target-specific native dependencies and rejects missing or cross-target prebuilds', () => {
    // risk: native runtime — a package must not silently reuse a different CPU's native module.
    const target = PackageTargetSpec.resolve('darwin', 'x64');
    const fs = new MemoryFileSystem();
    const manifest = new PackageTargetNativeDependencyManifest();

    target.nativeDependencyPaths.forEach(file => fs.files.set(`/repo/${ file }`, 'binary'));
    expect(manifest.problems('/repo', target, fs)).toEqual([]);
    expect(manifest.problems('/repo', PackageTargetSpec.resolve('darwin', 'arm64'), fs)).toHaveLength(5);
    fs.files.delete(`/repo/${ target.nativeDependencyPaths[0] }`);
    expect(manifest.problems('/repo', target, fs)).toContain(`${ target.nativeDependencyPaths[0] } is missing for darwin-x64`);
  });

  it('requires host runtime and guest-image assets while keeping guest images separate from host executable audits', () => {
    // risk: VM boot integrity — host Mach-O validation must not misclassify Linux guest payloads.
    const fs = new MemoryFileSystem();
    const manifest = new PackageTargetAssetManifest();

    for (const asset of PackageTargetAssetManifest.required) fs.files.set(`/app/resources/${ asset }`, 'fixture');
    expect(manifest.problems('/app/resources', fs)).toEqual([]);
    const hostExecutables = new Set<string>(PackageTargetAssetManifest.hostExecutables);
    expect(PackageTargetAssetManifest.guestImages.every(asset => !hostExecutables.has(asset))).toBe(true);
    expect(PackageTargetAssetManifest.optional).toContain('darwin/audio-driver/BlackHole2ch-0.6.1.pkg');
    fs.files.delete(`/app/resources/${ PackageTargetAssetManifest.guestImages[0] }`);
    expect(manifest.problems('/app/resources', fs)).toContain(`${ PackageTargetAssetManifest.guestImages[0] } is missing`);
  });

  it('records immutable target-keyed provenance and rejects stale markers after a target switch', () => {
    // risk: cross-target cache contamination — stale target assets must fail closed.
    const fs = new MemoryFileSystem();
    const provenance = new PackageTargetProvenance(fs);
    const x64 = PackageTargetSpec.resolve('darwin', 'x64');
    const arm64 = PackageTargetSpec.resolve('darwin', 'arm64');

    provenance.write('/dist/package-target.json', x64);
    expect(provenance.problems('/dist/package-target.json', x64)).toEqual([]);
    expect(provenance.problems('/dist/package-target.json', arm64)).toEqual(['packaging target provenance does not match darwin-arm64']);
  });
});
