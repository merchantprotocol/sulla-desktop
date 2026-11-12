// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import yaml from 'yaml';

import {
  NodePackageTargetFileSystem,
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
  readonly executableFiles = new Set<string>();
  exists(file: string): boolean { return this.files.has(file); }
  read(file: string): string { return this.files.get(file) ?? ''; }
  readBinary(file: string): Buffer { return Buffer.from(this.files.get(file) ?? ''); }
  isExecutable(file: string): boolean { return this.executableFiles.has(file); }
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
    const hostBinaries = new Set<string>(PackageTargetAssetManifest.hostMachOBinaries);
    expect(PackageTargetAssetManifest.guestImages.every(asset => !hostBinaries.has(asset))).toBe(true);
    expect(PackageTargetAssetManifest.optional).toContain('darwin/audio-driver/BlackHole2ch-0.6.1.pkg');
    fs.files.delete(`/app/resources/${ PackageTargetAssetManifest.guestImages[0] }`);
    expect(manifest.problems('/app/resources', fs)).toContain(`${ PackageTargetAssetManifest.guestImages[0] } is missing`);
  });

  it('checks shell-script assets for executability without parsing them as Mach-O', () => {
    // risk: packaged CLI availability — required host scripts must ship executable, while CPU checks apply only to native binaries.
    const target = PackageTargetSpec.resolve('darwin', 'x64');
    const fs = new MemoryFileSystem();
    for (const file of PackageTargetAssetManifest.hostScripts) {
      const fullPath = `/app/resources/${ file }`;
      fs.files.set(fullPath, '#!/bin/sh\n');
      fs.executableFiles.add(fullPath);
    }
    for (const file of PackageTargetAssetManifest.hostMachOBinaries) fs.files.set(`/app/resources/${ file }`, 'macho');
    const audited: string[] = [];
    const auditor = new PackageTargetNativeBinaryAuditor({ read: file => { audited.push(file); return ['x86_64']; } }, fs);

    expect(auditor.problems('/repo', '/app/resources', target)).toEqual([]);
    expect(audited).toEqual(PackageTargetAssetManifest.hostMachOBinaries.map(file => `/app/resources/${ file }`));

    fs.executableFiles.delete(`/app/resources/${ PackageTargetAssetManifest.hostScripts[0] }`);
    expect(auditor.problems('/repo', '/app/resources', target)).toContain(`${ PackageTargetAssetManifest.hostScripts[0] } is not executable`);
  });

  it('classifies the spin launcher as a host script and audits it without the Mach-O reader', () => {
    // risk: CLI availability — a shell launcher wrongly treated as Mach-O would fail every real build.
    const target = PackageTargetSpec.resolve('darwin', 'arm64');
    expect(PackageTargetAssetManifest.hostScripts).toContain('darwin/bin/spin');
    expect(PackageTargetAssetManifest.hostMachOBinaries).not.toContain('darwin/bin/spin');
    expect(PackageTargetAssetManifest.required).toContain('darwin/bin/spin');

    const root = mkdtempSync(path.join(os.tmpdir(), 'pkg-target-spin-'));
    try {
      const fileSystem = new NodePackageTargetFileSystem();
      // Real files and the real Mach-O reader: the synthetic launcher must not be parsed as a binary.
      const auditor = new PackageTargetNativeBinaryAuditor(undefined, fileSystem);
      for (const [index, shebang] of ['#!/bin/sh', '#!/bin/bash'].entries()) {
        const resources = path.join(root, `resources-${ index }`);
        for (const asset of PackageTargetAssetManifest.hostScripts) {
          const file = path.join(resources, asset);
          mkdirSync(path.dirname(file), { recursive: true });
          writeFileSync(file, `${ shebang }\nset -eu\nexec true\n`);
          chmodSync(file, 0o755);
        }
        expect(auditor.problems(root, resources, target)).toEqual([]);

        chmodSync(path.join(resources, 'darwin/bin/spin'), 0o644);
        expect(auditor.problems(root, resources, target)).toEqual(['darwin/bin/spin is not executable']);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps provenance stable across runtime signing but still detects guest-data mutation', () => {
    // risk: runtime provenance — signing must not cause a false mismatch or allow guest payload drift.
    const fs = new MemoryFileSystem();
    const assets = new PackageTargetAssetManifest();
    const provenance = new PackageTargetProvenance(fs);
    const target = PackageTargetSpec.resolve('darwin', 'arm64');
    for (const asset of PackageTargetAssetManifest.required) fs.files.set(`/resources/${ asset }`, `unsigned:${ asset }`);
    const beforeSigning = assets.fingerprint('/resources', fs);
    // External artifact directories are staged as resources before preparation; CPU validation must inspect that selected source.
    fs.files.set('/external/darwin/sulla-runtime/sulla-runtime', 'external-runtime');
    const externalRuntimeAuditor = new PackageTargetNativeBinaryAuditor({
      read: file => file === '/external/darwin/sulla-runtime/sulla-runtime' ? ['arm64'] : null,
    }, fs);
    expect(externalRuntimeAuditor.problems('/repo', '/external', PackageTargetSpec.resolve('darwin', 'x64'))).toContain(
      'darwin/sulla-runtime/sulla-runtime has CPU arm64, not x86_64',
    );

    provenance.write('/dist/package-target.json', target, beforeSigning);
    fs.files.set('/resources/darwin/sulla-runtime/sulla-runtime', 'codesign-mutated-signature-bytes');
    expect(assets.fingerprint('/resources', fs)).toBe(beforeSigning);
    expect(provenance.problems('/dist/package-target.json', target, assets.fingerprint('/resources', fs))).toEqual([]);
    fs.files.set('/resources/darwin/sulla-runtime/guest/usr.erofs', 'changed-guest-data');
    expect(provenance.problems('/dist/package-target.json', target, assets.fingerprint('/resources', fs))).toContain(
      'packaging target provenance does not match darwin-arm64',
    );
  });

  it('requires the node-pty spawn helper in unpacked output and configures its prebuilds outside asar', () => {
    // risk: terminal startup — node-pty must be able to execute spawn-helper from a real filesystem path.
    const target = PackageTargetSpec.resolve('darwin', 'arm64');
    const manifest = new PackageTargetNativeDependencyManifest();
    const helper = 'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper';
    const fs = new MemoryFileSystem();
    for (const dependency of target.nativeDependencyPaths) fs.files.set(`/unpacked/${ dependency.replace(/^node_modules\//, '') }`, 'binary');
    fs.files.delete(`/unpacked/${ helper.replace(/^node_modules\//, '') }`);
    expect(manifest.packagedProblems('/unpacked', target, fs)).toContain(
      `${ helper } is missing from packaged asar-unpacked output for ${ target.key }`,
    );
    fs.files.set(`/unpacked/${ helper.replace(/^node_modules\//, '') }`, 'helper');
    expect(manifest.packagedProblems('/unpacked', target, fs)).toEqual([]);
    const config = yaml.parse(readFileSync(path.join(process.cwd(), 'packaging/electron-builder.yml'), 'utf8'));
    expect(config.asarUnpack).toContain('node_modules/node-pty/prebuilds/**');
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
    for (const file of PackageTargetAssetManifest.hostMachOBinaries) fs.files.set(`/repo/resources/${ file }`, 'x64-macho');
    const auditor = new PackageTargetNativeBinaryAuditor({ read: () => ['x86_64'] }, fs);
    const prep = new PackageTargetPreparationService(new PackageTargetAssetManifest(), native, fs, auditor);
    for (const asset of PackageTargetAssetManifest.required) fs.files.set(`/repo/resources/${ asset }`, `runtime-${ x64.key }`);
    for (const script of PackageTargetAssetManifest.hostScripts) fs.executableFiles.add(`/repo/resources/${ script }`);
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
