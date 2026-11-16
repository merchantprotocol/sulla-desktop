// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs, { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
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
  RuntimeArtifactSourceValidator,
  StagedRuntimeInstaller,
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
  it('rejects symlinked required runtime assets in external artifact sources', async() => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pkg-runtime-source-'));
    const source = path.join(root, 'source');
    const external = path.join(root, 'external.img');
    try {
      mkdirSync(path.join(source, 'guest'), { recursive: true });
      for (const relative of ['sulla-runtime', 'guest/vmlinuz', 'guest/initramfs.img', 'guest/usr.erofs']) {
        writeFileSync(path.join(source, relative), relative);
      }
      writeFileSync(external, 'outside');
      expect(await new RuntimeArtifactSourceValidator().problems(source)).toEqual([]);
      rmSync(path.join(source, 'guest/usr.erofs'));
      symlinkSync(external, path.join(source, 'guest/usr.erofs'));
      expect(await new RuntimeArtifactSourceValidator().problems(source)).toContain('guest/usr.erofs must be a regular file, not a symlink or missing');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes the previous runtime and staging tree after a successful replacement', async() => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pkg-runtime-swap-'));
    const stage = path.join(root, '.sulla-runtime-stage-1');
    const target = path.join(root, 'resources/darwin/sulla-runtime');
    const staged = path.join(stage, 'resources/darwin/sulla-runtime');
    try {
      mkdirSync(target, { recursive: true });
      mkdirSync(staged, { recursive: true });
      writeFileSync(path.join(target, 'old'), 'previous');
      writeFileSync(path.join(staged, 'new'), 'replacement');
      await new StagedRuntimeInstaller().install(staged, target, stage);
      expect(readFileSync(path.join(target, 'new'), 'utf8')).toBe('replacement');
      expect(() => readFileSync(path.join(target, 'old'))).toThrow();
      expect(existsSync(stage)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('restores the previous runtime and removes staging when replacement fails', async() => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pkg-runtime-rollback-'));
    const stage = path.join(root, '.sulla-runtime-stage-1');
    const target = path.join(root, 'resources/darwin/sulla-runtime');
    const staged = path.join(stage, 'resources/darwin/sulla-runtime');
    let failedInstall = false;
    try {
      mkdirSync(target, { recursive: true });
      mkdirSync(staged, { recursive: true });
      writeFileSync(path.join(target, 'old'), 'previous');
      writeFileSync(path.join(staged, 'new'), 'replacement');
      await expect(new StagedRuntimeInstaller({
        rename: async(source, destination) => {
          if (source === staged && !failedInstall) {
            failedInstall = true;
            throw new Error('injected replacement failure');
          }
          await fs.promises.rename(source, destination);
        },
        remove: targetPath => fs.promises.rm(targetPath, { recursive: true, force: true }),
        exists: targetPath => fs.promises.access(targetPath).then(() => true, () => false),
      }).install(staged, target, stage)).rejects.toThrow('injected replacement failure');
      expect(readFileSync(path.join(target, 'old'), 'utf8')).toBe('previous');
      expect(existsSync(stage)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

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

  it('requires sherpa-onnx dylibs beside the hoisted addon, where @loader_path finds them', () => {
    // risk: native runtime — a real yarn install hoists sherpa-onnx-darwin-<arch>; a nested-only path made every real package fail the gate.
    const target = PackageTargetSpec.resolve('darwin', 'x64');
    const fs = new MemoryFileSystem();
    const manifest = new PackageTargetNativeDependencyManifest();
    const hoisted = ['sherpa-onnx.node', 'libonnxruntime.dylib', 'libsherpa-onnx-c-api.dylib'].map(name => `node_modules/sherpa-onnx-darwin-x64/${ name }`);

    target.nativeDependencyPaths.forEach(file => fs.files.set(`/repo/${ file }`, 'binary'));
    hoisted.forEach(file => expect(target.nativeDependencyPaths).toContain(file));
    expect(target.nativeDependencyPaths.some(file => file.includes('sherpa-onnx-node/node_modules'))).toBe(false);
    fs.files.delete('/repo/node_modules/sherpa-onnx-darwin-x64/libsherpa-onnx-c-api.dylib');
    expect(manifest.problems('/repo', target, fs)).toEqual(['node_modules/sherpa-onnx-darwin-x64/libsherpa-onnx-c-api.dylib is missing for darwin-x64']);
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
    const auditor = new PackageTargetNativeBinaryAuditor({ read: file => { audited.push(file); return ['x64']; } }, fs);

    expect(auditor.problems('/repo', '/app/resources', target)).toEqual([]);
    expect(audited).toEqual(PackageTargetAssetManifest.hostMachOBinaries.map(file => `/app/resources/${ file }`));

    fs.executableFiles.delete(`/app/resources/${ PackageTargetAssetManifest.hostScripts[0] }`);
    expect(auditor.problems('/repo', '/app/resources', target)).toContain(`${ PackageTargetAssetManifest.hostScripts[0] } is not executable`);
  });

  it('rejects packaged host scripts that lost execute permission', () => {
    // risk: packaged CLI availability — package output must preserve executable bits.
    const fs = new MemoryFileSystem();
    for (const script of PackageTargetAssetManifest.hostScripts) fs.files.set(`/app/resources/${ script }`, '#!/bin/sh');
    fs.executableFiles.add(`/app/resources/${ PackageTargetAssetManifest.hostScripts[0] }`);
    expect(new PackageTargetAssetManifest().packagedScriptProblems('/app/resources', fs)).toContain(
      `${ PackageTargetAssetManifest.hostScripts[1] } is not executable in packaged output`,
    );
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
      'darwin/sulla-runtime/sulla-runtime has CPU arm64, not x64',
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
    fs.executableFiles.add(`/unpacked/${ helper.replace(/^node_modules\//, '') }`);
    expect(manifest.packagedProblems('/unpacked', target, fs)).toEqual([]);
    const releaseHelper = '/unpacked/node-pty/build/Release/spawn-helper';
    fs.files.set('/unpacked/node-pty/build/Release/pty.node', 'release binary');
    fs.files.set(releaseHelper, 'release helper');
    expect(manifest.packagedProblems('/unpacked', target, fs)).toContain('node_modules/node-pty/build/Release/spawn-helper is not executable in packaged asar-unpacked output');
    fs.executableFiles.add(releaseHelper);
    expect(manifest.packagedProblems('/unpacked', target, fs)).toEqual([]);
    const config = yaml.parse(readFileSync(path.join(process.cwd(), 'packaging/electron-builder.yml'), 'utf8'));
    expect(config.asarUnpack).toContain('node_modules/node-pty/prebuilds/**');
    expect(config.asarUnpack).toContain('node_modules/node-pty/build/Release/**');
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
    const auditor = new PackageTargetNativeBinaryAuditor({ read: () => ['x64'] }, fs);
    const prep = new PackageTargetPreparationService(new PackageTargetAssetManifest(), native, fs, auditor);
    for (const asset of PackageTargetAssetManifest.required) fs.files.set(`/repo/resources/${ asset }`, `runtime-${ x64.key }`);
    for (const script of PackageTargetAssetManifest.hostScripts) fs.executableFiles.add(`/repo/resources/${ script }`);
    for (const file of x64.nativeDependencyPaths) fs.files.set(`/repo/${ file }`, 'x64-binary');
    const fetcher = { fetch: async() => undefined };
    const provenance = new PackageTargetProvenance(fs);
    expect(await prep.prepareAndRecord('/repo', '/repo/resources', x64, fetcher, '/dist/package-target.json', provenance)).toEqual([]);
    const priorMarker = fs.read('/dist/package-target.json');
    const problems = await prep.prepareAndRecord('/repo', '/repo/resources', arm64, fetcher, '/dist/package-target.json', provenance);
    // darwin/bin/sulla is a shell script (never CPU-audited); the real Mach-O host runtime is what must be rejected.
    expect(problems).toContain('darwin/sulla-runtime/sulla-runtime has CPU x64, not arm64');
    expect(problems.some(problem => problem.startsWith('darwin/bin/'))).toBe(false);
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

  it('rejects a symlinked guest directory and a symlinked runtime binary in artifact sources', async() => {
    // risk: packaging integrity — symlinks must not smuggle files from outside the artifact tree.
    const root = mkdtempSync(path.join(os.tmpdir(), 'pkg-runtime-symlink-dir-'));
    try {
      const outside = path.join(root, 'outside');
      mkdirSync(outside);
      for (const name of ['vmlinuz', 'initramfs.img', 'usr.erofs']) writeFileSync(path.join(outside, name), name);
      writeFileSync(path.join(root, 'real-runtime'), 'x');
      const source = path.join(root, 'source');
      mkdirSync(source);
      symlinkSync(outside, path.join(source, 'guest'));
      symlinkSync(path.join(root, 'real-runtime'), path.join(source, 'sulla-runtime'));
      const problems = await new RuntimeArtifactSourceValidator().problems(source);
      expect(problems).toContain('guest must be a real directory');
      expect(problems).toContain('sulla-runtime must be a regular file, not a symlink or missing');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the old runtime intact when the first rename of an install fails and when the target is absent', async() => {
    // risk: packaging integrity — a failed swap must never leave the runtime missing; first install has no backup.
    const root = mkdtempSync(path.join(os.tmpdir(), 'pkg-runtime-first-'));
    const stage = path.join(root, '.stage');
    const target = path.join(root, 'resources/darwin/sulla-runtime');
    const staged = path.join(stage, 'runtime');
    try {
      mkdirSync(staged, { recursive: true });
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(path.join(staged, 'new'), 'replacement');
      await new StagedRuntimeInstaller().install(staged, target, stage);
      expect(readFileSync(path.join(target, 'new'), 'utf8')).toBe('replacement');
      expect(existsSync(stage)).toBe(false);

      mkdirSync(path.join(stage, 'runtime'), { recursive: true });
      await expect(new StagedRuntimeInstaller({
        rename: async(source: string) => { if (source === target) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); },
        remove: p => fs.promises.rm(p, { recursive: true, force: true }),
        exists: p => fs.promises.access(p).then(() => true, () => false),
      }).install(staged, target, stage)).rejects.toThrow('EACCES');
      expect(readFileSync(path.join(target, 'new'), 'utf8')).toBe('replacement');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects real wrong-architecture Mach-O headers and a wrong-arch node-pty build/Release selection', () => {
    // risk: native runtime — a real header of another CPU must fail, including node-pty's build/Release preferred path.
    const root = mkdtempSync(path.join(os.tmpdir(), 'pkg-macho-real-'));
    const header = (cpu: number) => { const b = Buffer.alloc(32); b.writeUInt32BE(0xcffaedfe, 0); b.writeUInt32LE(cpu, 4); return b; };
    const X64 = 0x01000007;
    const ARM64 = 0x0100000c;
    try {
      const target = PackageTargetSpec.resolve('darwin', 'arm64');
      const resources = path.join(root, 'resources');
      const runtime = path.join(resources, 'darwin/sulla-runtime/sulla-runtime');
      mkdirSync(path.dirname(runtime), { recursive: true });
      writeFileSync(runtime, header(X64));
      for (const dependency of target.nativeDependencyPaths) {
        const file = path.join(root, dependency);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, header(ARM64));
        chmodSync(file, 0o755);
      }
      const auditor = new PackageTargetNativeBinaryAuditor();
      expect(auditor.problems(root, resources, target)).toEqual(['darwin/sulla-runtime/sulla-runtime has CPU x64, not arm64']);
      writeFileSync(runtime, header(ARM64));
      expect(auditor.problems(root, resources, target)).toEqual([]);

      // The same real x64 header passes for an x64 target (reader names must match the auditor's).
      const x64Target = PackageTargetSpec.resolve('darwin', 'x64');
      const x64Root = path.join(root, 'x64');
      const x64Runtime = path.join(x64Root, 'resources/darwin/sulla-runtime/sulla-runtime');
      mkdirSync(path.dirname(x64Runtime), { recursive: true });
      writeFileSync(x64Runtime, header(X64));
      for (const dependency of x64Target.nativeDependencyPaths) {
        const file = path.join(x64Root, dependency);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, header(X64));
      }
      expect(auditor.problems(x64Root, path.join(x64Root, 'resources'), x64Target)).toEqual([]);

      const releaseBinary = path.join(root, 'node_modules/node-pty/build/Release/pty.node');
      const releaseHelper = path.join(root, 'node_modules/node-pty/build/Release/spawn-helper');
      mkdirSync(path.dirname(releaseBinary), { recursive: true });
      writeFileSync(releaseBinary, header(X64));
      writeFileSync(releaseHelper, '#!/bin/sh');
      chmodSync(releaseHelper, 0o755);
      expect(auditor.problems(root, resources, target)).toEqual(['node_modules/node-pty/build/Release/pty.node has CPU x64, not arm64']);
      chmodSync(releaseHelper, 0o644);
      expect(auditor.problems(root, resources, target)).toContain('node_modules/node-pty/build/Release/spawn-helper is not executable');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('detects tampered provenance fields and a changed runtime fingerprint', () => {
    // risk: provenance integrity — an edited marker or swapped runtime binary must not verify.
    const fs = new MemoryFileSystem();
    const provenance = new PackageTargetProvenance(fs);
    const target = PackageTargetSpec.resolve('darwin', 'x64');
    provenance.write('/p.json', target, 'fp', 'rt1');
    expect(provenance.problems('/p.json', target, 'fp', 'rt1')).toEqual([]);
    expect(provenance.problems('/p.json', target, 'fp', 'rt2')).toEqual(['packaging target provenance does not match darwin-x64']);
    fs.files.set('/p.json', fs.read('/p.json').replace('"guestArch": "amd64"', '"guestArch": "arm64"'));
    expect(provenance.problems('/p.json', target, 'fp', 'rt1')).toEqual(['packaging target provenance does not match darwin-x64']);
    fs.files.set('/p.json', '{nope');
    expect(provenance.problems('/p.json', target, 'fp')).toEqual(['packaging target provenance is invalid JSON']);
    expect(provenance.problems('/missing.json', target, 'fp')).toEqual(['packaging target provenance is missing']);
  });
});
