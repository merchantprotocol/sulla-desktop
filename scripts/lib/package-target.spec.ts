// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import {
  PackageTargetAssetManifest,
  PackageTargetNativeDependencyManifest,
  PackageTargetNativeBinaryAuditor,
  PackageTargetPreparationService,
  PackageTargetProvenance,
  PackageTargetSpec,
  type PackageTargetFileSystem,
} from './package-target';

class MemoryFileSystem implements PackageTargetFileSystem {
  readonly files = new Map<string, string>();
  exists(file: string): boolean { return this.files.has(file); }
  read(file: string): string { return this.files.get(file) ?? ''; }
  readBinary(file: string): Buffer { return Buffer.from(this.files.get(file) ?? ''); }
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
    expect(manifest.problems('/repo', PackageTargetSpec.resolve('darwin', 'arm64'), fs)).toHaveLength(target.nativeDependencyPaths.length);
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

    provenance.write('/dist/package-target.json', x64, 'x64-assets');
    expect(provenance.problems('/dist/package-target.json', x64, 'x64-assets')).toEqual([]);
    expect(provenance.problems('/dist/package-target.json', arm64, 'x64-assets')).toEqual(['packaging target provenance does not match darwin-arm64']);
  });

  it('does not bless a reused wrong-architecture asset tree when switching target before packaging', async() => {
    // risk: cross-target native runtime — a stale cache cannot be relabelled for a new host CPU.
    const fs = new MemoryFileSystem();
    const x64 = PackageTargetSpec.resolve('darwin', 'x64');
    const arm64 = PackageTargetSpec.resolve('darwin', 'arm64');
    const native = new PackageTargetNativeDependencyManifest();
    for (const file of PackageTargetAssetManifest.hostExecutables) fs.files.set(`/repo/resources/${ file }`, 'x64-macho');
    const auditor = new PackageTargetNativeBinaryAuditor({ read: () => ['x86_64'] }, fs);
    const prep = new PackageTargetPreparationService(new PackageTargetAssetManifest(), native, fs, auditor);
    for (const asset of PackageTargetAssetManifest.required) fs.files.set(`/repo/resources/${ asset }`, `runtime-${ x64.key }`);
    for (const file of x64.nativeDependencyPaths) fs.files.set(`/repo/${ file }`, 'x64-binary');
    const fetcher = { fetch: async() => undefined };
    const provenance = new PackageTargetProvenance(fs);
    expect(await prep.prepareAndRecord('/repo', '/repo/resources', x64, fetcher, '/dist/package-target.json', provenance)).toEqual([]);
    const priorMarker = fs.read('/dist/package-target.json');
    const problems = await prep.prepareAndRecord('/repo', '/repo/resources', arm64, fetcher, '/dist/package-target.json', provenance);
    expect(problems).toContain('darwin/bin/sulla has CPU x86_64, not arm64');
    expect(native.problems('/repo', arm64, fs)).toHaveLength(arm64.nativeDependencyPaths.length);
    // The real prepare-and-record sequence leaves the last verified marker intact on target-switch failure.
    expect(fs.read('/dist/package-target.json')).toBe(priorMarker);
    expect(provenance.problems('/dist/package-target.json', x64, prep.fingerprint('/repo/resources'))).toEqual([]);
  });

  it('rejects required native dependencies omitted from electron-builder packaged output', () => {
    // risk: native runtime — electron-builder filtering must not silently strip a required addon.
    const target = PackageTargetSpec.resolve('darwin', 'arm64');
    const fs = new MemoryFileSystem();
    const manifest = new PackageTargetNativeDependencyManifest();
    target.nativeDependencyPaths.forEach(file => fs.files.set(`/app/unpacked/${ file.replace(/^node_modules\//, '') }`, 'binary'));
    fs.files.delete(`/app/unpacked/${ target.nativeDependencyPaths[0].replace(/^node_modules\//, '') }`);
    expect(manifest.packagedProblems('/app/unpacked', target, fs)).toContain(
      `${ target.nativeDependencyPaths[0] } is missing from packaged asar-unpacked output for ${ target.key }`,
    );
  });

  it('fails closed when native ABI or binary kind cannot be reliably identified', () => {
    // risk: native runtime — unknown binary formats are not represented as fully ABI-validated.
    const target = PackageTargetSpec.resolve('darwin', 'x64');
    const fs = new MemoryFileSystem();
    for (const file of target.nativeDependencyPaths) fs.files.set(`/repo/${ file }`, 'unknown');
    const auditor = new PackageTargetNativeBinaryAuditor({ read: () => null }, fs);
    expect(auditor.problems('/repo', '/repo/resources', target)[0]).toContain('ABI/binary kind cannot be validated');
  });
});
