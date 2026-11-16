// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { spawnSync } from 'child_process';

import { NativeAbiAudit } from './native-abi';

export interface RebuildProcess {
  status: number | null;
  signal: string | null;
  stderr: string;
  error?: string;
}

/** Runs a command with an argv array (never a shell). */
export interface RebuildRunner {
  run(command: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): RebuildProcess;
}

export class SpawnRebuildRunner implements RebuildRunner {
  run(command: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): RebuildProcess {
    const result = spawnSync(command, [...args], { cwd: options.cwd, env: options.env, timeout: options.timeoutMs, encoding: 'utf8', stdio: ['ignore', 'inherit', 'pipe'], shell: false, maxBuffer: 1 << 24 });

    return { status: result.status, signal: result.signal, stderr: result.stderr ?? '', error: result.error?.message };
  }
}

/** Finds @electron/rebuild's CLI the way the package script finds node-abi: through electron-builder, which depends on it. */
export class ElectronRebuildCliLocator {
  constructor(private readonly projectRoot: string = process.cwd()) {}

  locate(): string {
    const projectRequire = createRequire(path.join(this.projectRoot, 'noop.js'));
    const builderEntry = projectRequire.resolve('electron-builder');
    const entry = projectRequire.resolve('@electron/rebuild', { paths: [path.dirname(builderEntry), this.projectRoot] });
    const cli = path.join(path.dirname(entry), 'cli.js');

    if (!fs.existsSync(cli)) throw new Error(`@electron/rebuild has no CLI at ${ cli }`);

    return cli;
  }
}

/**
 * Which node_modules packages need a target-specific rebuild: the ABI-bound
 * addons the app cannot run without (NativeAbiAudit.REQUIRED_ADDONS) plus any
 * other production dependency that compiles from source (has binding.gyp) and
 * ships no prebuilds. Packages that ship per-CPU prebuilds (node-pty, xattr,
 * onnxruntime, sherpa-onnx) are verified by the target-file checks instead.
 */
export class NativeRebuildModules {
  constructor(private readonly projectRoot: string = process.cwd()) {}

  list(): string[] {
    const required = NativeAbiAudit.REQUIRED_ADDONS.map(rel => this.packageOf(rel));
    const pkg = JSON.parse(fs.readFileSync(path.join(this.projectRoot, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
    const production = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})];
    const compiled = production.filter((name) => {
      const dir = path.join(this.projectRoot, 'node_modules', name);

      return fs.existsSync(path.join(dir, 'binding.gyp')) && !fs.existsSync(path.join(dir, 'prebuilds'));
    });

    return [...new Set([...required, ...compiled])].sort();
  }

  /** `better-sqlite3/build/...` -> `better-sqlite3`; `@scope/pkg/build/...` -> `@scope/pkg`. */
  private packageOf(relative: string): string {
    const parts = relative.split('/');

    return parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  }
}

/**
 * Rebuilds native modules for the Electron being packaged, in a plain Node
 * subprocess. @electron/rebuild cannot be imported under tsx 4.21 (its
 * `import.meta.dirname` is undefined there), and electron-builder's own rebuild
 * trusts `.forge-meta` markers, so the package step runs this explicitly and
 * then tells electron-builder not to rebuild again (`npmRebuild: false`).
 * Fails closed: any non-zero exit, signal, timeout or spawn error throws.
 */
export class NativeRebuildCommand {
  private static readonly ARCHES = Object.freeze(['x64', 'arm64'] as const);
  private static readonly VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
  private static readonly MODULE = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/;

  constructor(
    private readonly projectRoot: string,
    private readonly cliPath: string,
    private readonly nodePath: string = process.execPath,
    private readonly runner: RebuildRunner = new SpawnRebuildRunner(),
    private readonly timeoutMs = 30 * 60 * 1000,
  ) {}

  /** The exact argv handed to Node: the CLI script, then force, modules, Electron version and target CPU. */
  argv(modules: readonly string[], electronVersion: string, arch: string): string[] {
    if (!NativeRebuildCommand.VERSION.test(electronVersion)) throw new Error(`Refusing to rebuild for malformed Electron version "${ electronVersion }"`);
    if (!(NativeRebuildCommand.ARCHES as readonly string[]).includes(arch)) throw new Error(`Refusing to rebuild for unsupported architecture "${ arch }"`);
    if (!modules.length) throw new Error('No native modules to rebuild');
    for (const name of modules) if (!NativeRebuildCommand.MODULE.test(name)) throw new Error(`Refusing to rebuild malformed module name "${ name }"`);

    return [this.cliPath, '-f', '-w', modules.join(','), '-v', electronVersion, '-a', arch];
  }

  /**
   * Plain-Node environment: the running Node's directory leads PATH so node-gyp
   * children resolve the same `node`, and tsx's loader hooks are dropped from
   * NODE_OPTIONS so the child is not itself running under tsx.
   */
  env(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...base };
    const options = (base.NODE_OPTIONS ?? '').split(/\s+/).filter(Boolean);
    const kept: string[] = [];

    for (let i = 0; i < options.length; i++) {
      const option = options[i];
      const takesValue = ['--import', '--require', '-r', '--loader', '--experimental-loader'].includes(option);

      if (takesValue && /tsx/.test(options[i + 1] ?? '')) { i++; continue; }
      if (/^--(?:import|require|loader|experimental-loader)=.*tsx/.test(option)) continue;
      kept.push(option);
    }
    if (kept.length) env.NODE_OPTIONS = kept.join(' ');
    else delete env.NODE_OPTIONS;
    for (const key of Object.keys(env)) if (key.startsWith('TSX_')) delete env[key];
    env.PATH = [path.dirname(this.nodePath), base.PATH].filter(Boolean).join(path.delimiter);

    return env;
  }

  run(modules: readonly string[], electronVersion: string, arch: string): void {
    const result = this.runner.run(this.nodePath, this.argv(modules, electronVersion, arch), { cwd: this.projectRoot, env: this.env(), timeoutMs: this.timeoutMs });

    if (result.error || result.signal || result.status !== 0) {
      const detail = (result.error ?? result.stderr).trim().split('\n').slice(-5).join(' | ').slice(0, 600);

      throw new Error(`Native rebuild of ${ modules.join(', ') } for Electron ${ electronVersion } ${ arch } failed (${ result.signal ? `signal ${ result.signal }` : `exit ${ result.status }` }): ${ detail }`);
    }
  }
}
