// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  NativeAbiAudit, NativeAddonAbiReader, PackagedNativeLoadSmoke, SpawnSmokeRunner, StaleRebuildMarkerRepair,
  type SmokeProcess, type SmokeRunner,
} from './native-abi';

const dirs: string[] = [];

/** Writes a binary-like file carrying the given registration symbols, as a compiled addon does. */
class AddonFiles {
  readonly root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-abi-'));

  constructor() { dirs.push(this.root); }

  add(rel: string, symbols: string[] = []): string {
    const file = path.join(this.root, rel);

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1]), ...symbols.map(symbol => Buffer.from(`\0${ symbol }\0`))]));

    return file;
  }
}

afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('NativeAddonAbiReader', () => {
  // risk: shipping an addon built for the wrong runtime
  it('reads the Node ABI of a NODE_MODULE addon, tells N-API addons apart, and flags ambiguity', () => {
    const files = new AddonFiles();
    const reader = new NativeAddonAbiReader();

    expect(reader.read(files.add('a.node', ['node_register_module_v127']))).toEqual({ kind: 'abi', abi: 127 });
    expect(reader.read(files.add('b.node', ['napi_register_module_v1']))).toEqual({ kind: 'napi' });
    expect(reader.read(files.add('c.node', ['node_register_module_v127', 'node_register_module_v143']))).toEqual({ kind: 'ambiguous', abis: [127, 143] });
    expect(reader.read(files.add('d.node'))).toEqual({ kind: 'unknown' });
  });
});

describe('NativeAbiAudit', () => {
  // risk: the Intel build shipped better-sqlite3 for Node 22 (ABI 127) inside Electron 40 (ABI 143)
  it('rejects a Node-22 better-sqlite3 in an Electron-40 app and accepts the rebuilt one', () => {
    const files = new AddonFiles();
    const audit = new NativeAbiAudit();
    const stale = files.add('stale/better-sqlite3/build/Release/better_sqlite3.node', ['node_register_module_v127']);
    const rebuilt = files.add('good/better-sqlite3/build/Release/better_sqlite3.node', ['node_register_module_v143']);
    const napi = files.add('good/node-pty/pty.node', ['napi_register_module_v1']);

    expect(audit.problems([stale], 143)).toEqual([`${ stale } was built for Node ABI 127 but Electron needs 143`]);
    expect(audit.problems([rebuilt, napi], 143)).toEqual([]);
  });

  // risk: a package with no better-sqlite3 at all passes an "everything present is fine" scan
  it('packagedProblems requires better_sqlite3.node and checks every addon in the unpacked tree', () => {
    const files = new AddonFiles();
    const audit = new NativeAbiAudit();
    const unpacked = path.join(files.root, 'app.asar.unpacked');

    files.add('app.asar.unpacked/node_modules/x/x.node', ['node_register_module_v143']);
    expect(audit.packagedProblems(unpacked, 143)).toEqual([`${ path.join(unpacked, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node') } is missing, so its Node ABI cannot be checked`]);
    files.add('app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node', ['node_register_module_v143']);
    expect(audit.packagedProblems(unpacked, 143)).toEqual([]);
    files.add('app.asar.unpacked/node_modules/x/x.node', ['node_register_module_v127']);
    expect(audit.packagedProblems(unpacked, 143)).toHaveLength(1);
  });

  it('fails closed on a missing addon and finds every .node in a tree', () => {
    const files = new AddonFiles();
    const audit = new NativeAbiAudit();
    const nested = files.add('node_modules/deep/er/x.node', ['node_register_module_v143']);

    files.add('node_modules/readme.txt');
    expect(audit.addonsUnder(files.root)).toEqual([nested]);
    expect(audit.problems([path.join(files.root, 'gone.node')], 143)[0]).toMatch(/is missing/);
  });
});

describe('StaleRebuildMarkerRepair', () => {
  // risk: @electron/rebuild trusts .forge-meta, so a stale "x64--143" beside an ABI-127 binary skips the rebuild
  it('removes only a marker that contradicts the binary beside it, never the binary', () => {
    const files = new AddonFiles();
    const repair = new StaleRebuildMarkerRepair();
    const staleAddon = files.add('node_modules/better-sqlite3/build/Release/better_sqlite3.node', ['node_register_module_v127']);
    const staleMarker = path.join(path.dirname(staleAddon), '.forge-meta');
    const goodAddon = files.add('node_modules/other/build/Release/other.node', ['node_register_module_v143']);
    const goodMarker = path.join(path.dirname(goodAddon), '.forge-meta');

    fs.writeFileSync(staleMarker, 'x64--143');
    fs.writeFileSync(goodMarker, 'x64--143');

    const removed = repair.repair(repair.discover(path.join(files.root, 'node_modules')), 143);

    expect(removed).toEqual([staleMarker]);
    expect(fs.existsSync(staleMarker)).toBe(false);
    expect(fs.existsSync(staleAddon)).toBe(true);
    expect(fs.existsSync(goodMarker)).toBe(true);
  });

  it('removes a marker whose addon is gone (the rebuild must produce one)', () => {
    const files = new AddonFiles();
    const repair = new StaleRebuildMarkerRepair();
    const marker = path.join(files.root, 'node_modules', 'x', 'build', 'Release', '.forge-meta');

    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, 'x64--143');

    expect(repair.repair(repair.discover(path.join(files.root, 'node_modules')), 143)).toEqual([marker]);
  });
});

describe('PackagedNativeLoadSmoke', () => {
  class ScriptedRunner implements SmokeRunner {
    readonly calls: string[][] = [];
    constructor(private readonly outcomes: Record<string, SmokeProcess>) {}
    run(_command: string, args: string[]): SmokeProcess {
      this.calls.push(args);

      return this.outcomes[args[args.length - 1]] ?? { status: 0, signal: null, stdout: 'ok', stderr: '' };
    }
  }

  // risk: a signed addon that SIGILLs on load (posix-node x86_64-macos.node) is reported per addon, others still checked
  it('reports a crashing addon by name and still loads the rest', () => {
    const runner = new ScriptedRunner({
      '--abi': { status: 0, signal: null, stdout: '143', stderr: '' },
      '/app/bad.node': { status: null, signal: 'SIGILL', stdout: '', stderr: '' },
    });
    const problems = new PackagedNativeLoadSmoke(runner).problems('/app/Electron', ['/app/bad.node', '/app/fine.node'], 143);

    expect(problems).toEqual(['/app/bad.node failed to load in the packaged Electron (signal SIGILL)']);
    expect(runner.calls.length).toBe(3);
  });

  // risk: packaged Electron on a different ABI than the one native modules were rebuilt for
  it('fails when the packaged Electron reports a different Node ABI', () => {
    const runner = new ScriptedRunner({ '--abi': { status: 0, signal: null, stdout: '127', stderr: '' } });

    expect(new PackagedNativeLoadSmoke(runner).problems('/app/Electron', [], 143)).toEqual(['packaged Electron reports Node ABI 127, expected 143']);
  });

  it('fails when the packaged Electron cannot be started at all', () => {
    const runner = new ScriptedRunner({ '--abi': { status: null, signal: null, stdout: '', stderr: '', error: 'spawn ENOENT' } });

    expect(new PackagedNativeLoadSmoke(runner).problems('/app/Electron', ['/app/a.node'], 143)[0]).toMatch(/did not start/);
  });

  // real child process: the loader script itself reads the runtime ABI and rejects a file that is not an addon
  it('runs the real loader script: reports process.versions.modules and refuses a non-addon file', () => {
    const files = new AddonFiles();
    const notAddon = path.join(files.root, 'fake.node');

    fs.writeFileSync(notAddon, 'not a mach-o');
    const smoke = new PackagedNativeLoadSmoke(new SpawnSmokeRunner());
    const abi = Number(process.versions.modules);

    expect(smoke.problems(process.execPath, [], abi)).toEqual([]);
    expect(smoke.problems(process.execPath, [], abi + 1)).toEqual([`packaged Electron reports Node ABI ${ abi }, expected ${ abi + 1 }`]);
    expect(smoke.problems(process.execPath, [notAddon], abi)[0]).toContain(`${ notAddon } failed to load`);
  });
});
