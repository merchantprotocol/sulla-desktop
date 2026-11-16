// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { spawnSync } from 'child_process';

/**
 * What a native addon declares about the runtime it was compiled for.
 * `abi` addons (NODE_MODULE macro) embed `node_register_module_v<N>` and only
 * load in a runtime whose process.versions.modules is N. `napi` addons are
 * ABI-stable across runtimes. `unknown` has no Node registration symbol.
 */
export type AddonAbi =
  | { kind: 'abi'; abi: number }
  | { kind: 'ambiguous'; abis: number[] }
  | { kind: 'napi' }
  | { kind: 'unknown' };

/** Decodes the Node ABI an addon was built for from its registration symbol. */
export class NativeAddonAbiReader {
  read(file: string): AddonAbi {
    const text = fs.readFileSync(file).toString('latin1');
    const abis = [...new Set([...text.matchAll(/node_register_module_v(\d+)/g)].map(match => Number(match[1])))].sort((a, b) => a - b);

    if (abis.length === 1) return { kind: 'abi', abi: abis[0] };
    if (abis.length > 1) return { kind: 'ambiguous', abis };

    return /napi_register_module_v\d+|node_api_module_get_api_version_v\d+/.test(text) ? { kind: 'napi' } : { kind: 'unknown' };
  }
}

/** Maps an Electron version to the Node ABI (process.versions.modules) it runs. */
export interface ElectronAbiSource {
  abiFor(electronVersion: string): number;
}

/** Uses node-abi (a dependency of electron-builder's rebuild step), the same table @electron/rebuild targets. */
export class NodeAbiElectronSource implements ElectronAbiSource {
  constructor(private readonly resolveFrom: string = process.cwd()) {}

  abiFor(electronVersion: string): number {
    // package.ts runs as native ESM under tsx, where `require` is undefined; anchor a CJS resolver at the project.
    const projectRequire = createRequire(path.join(this.resolveFrom, 'noop.js'));
    const builderEntry = projectRequire.resolve('electron-builder');
    const nodeAbi = projectRequire(projectRequire.resolve('node-abi', { paths: [path.dirname(builderEntry), this.resolveFrom] }));
    const abi = Number(nodeAbi.getAbi(electronVersion, 'electron'));

    if (!Number.isInteger(abi) || abi <= 0) throw new Error(`Cannot determine the Node ABI of Electron ${ electronVersion }`);

    return abi;
  }
}

/**
 * Fails when a native addon was compiled for a Node ABI other than the
 * Electron runtime it ships in. Nothing about the file's CPU, signature or
 * presence reveals this: a Node-22 build of better-sqlite3 (ABI 127) is a
 * perfectly valid x64 Mach-O that Electron 40 (ABI 143) refuses to load.
 */
export class NativeAbiAudit {
  /** Node-ABI addons the app cannot run without (the file-search worker loads better-sqlite3); relative to node_modules. */
  static readonly REQUIRED_ADDONS = Object.freeze(['better-sqlite3/build/Release/better_sqlite3.node'] as const);

  /** ABI problems for everything under a packaged `app.asar.unpacked`, plus a missing required addon. */
  packagedProblems(unpackedRoot: string, expectedAbi: number): string[] {
    const required = NativeAbiAudit.REQUIRED_ADDONS.map(rel => path.join(unpackedRoot, 'node_modules', rel));
    const files = [...new Set([...required, ...this.addonsUnder(unpackedRoot)])];

    return this.problems(files, expectedAbi);
  }

  constructor(private readonly reader: NativeAddonAbiReader = new NativeAddonAbiReader()) {}

  problems(files: readonly string[], expectedAbi: number): string[] {
    return files.flatMap((file) => {
      if (!fs.existsSync(file)) return [`${ file } is missing, so its Node ABI cannot be checked`];
      const abi = this.reader.read(file);

      if (abi.kind === 'abi' && abi.abi !== expectedAbi) {
        return [`${ file } was built for Node ABI ${ abi.abi } but Electron needs ${ expectedAbi }`];
      }
      if (abi.kind === 'ambiguous') return [`${ file } declares several Node ABIs (${ abi.abis.join(', ') })`];

      return [];
    });
  }

  /** Every addon under a tree (skipping nothing), so a new native module cannot dodge the check. */
  addonsUnder(root: string): string[] {
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);

        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && entry.name.endsWith('.node')) found.push(full);
      }
    };

    if (fs.existsSync(root)) walk(root);

    return found.sort();
  }
}

/**
 * @electron/rebuild decides whether a module is already built by reading
 * `build/Release/.forge-meta` ("<arch>--<abi>"), never by looking at the
 * binary. A marker left saying "x64--143" beside a better_sqlite3.node that
 * still holds Node 22 (ABI 127) makes electron-builder log "finished
 * better-sqlite3" without rebuilding anything. This removes only that marker
 * when the binary disagrees with it, so the rebuild that follows is real.
 * Binaries are never touched.
 */
export class StaleRebuildMarkerRepair {
  constructor(private readonly reader: NativeAddonAbiReader = new NativeAddonAbiReader()) {}

  /** Every `.forge-meta` under `<nodeModules>/<pkg>/build/Release` paired with the addon beside it. */
  discover(nodeModules: string): Array<{ addon: string; marker: string }> {
    if (!fs.existsSync(nodeModules)) return [];

    return fs.readdirSync(nodeModules).flatMap((name) => {
      const release = path.join(nodeModules, name, 'build', 'Release');
      const marker = path.join(release, '.forge-meta');

      if (!fs.existsSync(marker)) return [];
      const addons = fs.readdirSync(release).filter(file => file.endsWith('.node'));

      return addons.length ? addons.map(file => ({ addon: path.join(release, file), marker })) : [{ addon: path.join(release, `${ name }.node`), marker }];
    });
  }

  /** Returns the markers removed. */
  repair(addons: ReadonlyArray<{ addon: string; marker: string }>, expectedAbi: number): string[] {
    const removed: string[] = [];

    for (const { addon, marker } of addons) {
      if (!fs.existsSync(marker)) continue;
      const abi = fs.existsSync(addon) ? this.reader.read(addon) : { kind: 'unknown' as const };
      const stale = abi.kind === 'abi' ? abi.abi !== expectedAbi : abi.kind === 'ambiguous';

      if (stale || !fs.existsSync(addon)) {
        fs.rmSync(marker);
        removed.push(marker);
      }
    }

    return removed;
  }
}

export interface SmokeProcess {
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface SmokeRunner {
  run(command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): SmokeProcess;
}

export class SpawnSmokeRunner implements SmokeRunner {
  run(command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): SmokeProcess {
    const result = spawnSync(command, args, { env, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 1 << 20 });

    return { status: result.status, signal: result.signal, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error?.message };
  }
}

/**
 * Loads every native addon the packaged app needs, inside the packaged
 * Electron binary itself (ELECTRON_RUN_AS_NODE=1: no window, no main-app
 * launch, bounded by a timeout), so what is verified is the real runtime ABI
 * and the real signed bytes. Each addon is loaded in its own child process: a
 * crashing addon (SIGILL from a mis-signed binary) reports as that addon's
 * problem instead of hiding the others.
 */
export class PackagedNativeLoadSmoke {
  static readonly LOADER = [
    'const m = process.versions.modules;',
    'if (process.argv[1] === "--abi") { process.stdout.write(String(m)); process.exit(0); }',
    'const mod = { exports: {} };',
    'process.dlopen(mod, process.argv[1]);',
    'process.stdout.write("ok");',
  ].join('\n');

  constructor(
    private readonly runner: SmokeRunner = new SpawnSmokeRunner(),
    // A freshly signed x64 app's first launch under Rosetta (translation + Gatekeeper assessment) exceeded 20s; later launches take ~1s.
    private readonly timeoutMs = 120000,
  ) {}

  /** `electronBinary` is `<App>.app/Contents/MacOS/<name>`; `addons` are absolute paths inside the packaged app. */
  problems(electronBinary: string, addons: readonly string[], expectedAbi: number): string[] {
    const env = { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '', ELECTRON_RUN_AS_NODE: '1' };
    const abiRun = this.runner.run(electronBinary, ['-e', PackagedNativeLoadSmoke.LOADER, '--', '--abi'], env, this.timeoutMs);
    const problems: string[] = [];

    if (abiRun.error || abiRun.status !== 0) {
      return [`packaged Electron did not start for the native smoke (${ this.describe(abiRun) })`];
    }
    if (abiRun.stdout.trim() !== String(expectedAbi)) {
      problems.push(`packaged Electron reports Node ABI ${ abiRun.stdout.trim() }, expected ${ expectedAbi }`);
    }
    for (const addon of addons) {
      const run = this.runner.run(electronBinary, ['-e', PackagedNativeLoadSmoke.LOADER, '--', addon], env, this.timeoutMs);

      if (run.error || run.status !== 0 || run.stdout.trim() !== 'ok') {
        problems.push(`${ addon } failed to load in the packaged Electron (${ this.describe(run) })`);
      }
    }

    return problems;
  }

  private describe(run: SmokeProcess): string {
    const detail = (run.error ?? run.stderr).trim().split('\n').find(line => line.trim()) ?? '';

    return [run.signal ? `signal ${ run.signal }` : `exit ${ run.status }`, detail.slice(0, 200)].filter(Boolean).join(': ');
  }
}

/**
 * The whole native gate for one packaged, signed `.app`: ABI of every addon in
 * app.asar.unpacked, then a real load of each addon the app needs inside its
 * own Electron. `requiredAddons` are paths relative to node_modules.
 */
export class PackagedAppNativeGate {
  constructor(
    private readonly audit: NativeAbiAudit = new NativeAbiAudit(),
    private readonly smoke: PackagedNativeLoadSmoke = new PackagedNativeLoadSmoke(),
  ) {}

  problems(appPath: string, executableName: string, requiredAddons: readonly string[], expectedAbi: number): string[] {
    const unpacked = path.join(appPath, 'Contents', 'Resources', 'app.asar.unpacked');
    const abiProblems = this.audit.packagedProblems(unpacked, expectedAbi);
    const toLoad = [...new Set([...NativeAbiAudit.REQUIRED_ADDONS, ...requiredAddons].filter(rel => rel.endsWith('.node')))]
      .map(rel => path.join(unpacked, 'node_modules', rel.replace(/^node_modules\//, '')));

    return [...abiProblems, ...this.smoke.problems(path.join(appPath, 'Contents', 'MacOS', executableName), toLoad, expectedAbi)];
  }
}
