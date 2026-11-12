// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { NativeRebuildCommand, NativeRebuildModules, SpawnRebuildRunner, type RebuildProcess, type RebuildRunner } from './native-rebuild';

const dirs: string[] = [];

class TempProject {
  readonly root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-rebuild-'));

  constructor() { dirs.push(this.root); }

  write(rel: string, content = ''): this {
    const file = path.join(this.root, rel);

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);

    return this;
  }
}

class RecordingRunner implements RebuildRunner {
  calls: Array<{ command: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv }> = [];

  constructor(private readonly result: RebuildProcess = { status: 0, signal: null, stderr: '' }) {}

  run(command: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }): RebuildProcess {
    this.calls.push({ command, args, cwd: options.cwd, env: options.env });

    return this.result;
  }
}

afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('NativeRebuildCommand', () => {
  // risk: an Intel package rebuilt for the wrong Electron version or CPU (ABI 127 better-sqlite3 in an ABI 143 app)
  it('runs the CLI under the given node with force, modules, exact Electron version and target arch as separate argv entries', () => {
    const runner = new RecordingRunner();

    new NativeRebuildCommand('/proj', '/proj/node_modules/@electron/rebuild/lib/cli.js', '/opt/node-x64/bin/node', runner).run(['better-sqlite3', 'native-reg'], '40.0.0', 'x64');

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].command).toBe('/opt/node-x64/bin/node');
    expect(runner.calls[0].args).toEqual(['/proj/node_modules/@electron/rebuild/lib/cli.js', '-f', '-w', 'better-sqlite3,native-reg', '-v', '40.0.0', '-a', 'x64']);
    expect(runner.calls[0].cwd).toBe('/proj');
  });

  // risk: arm64 build host rebuilding for itself instead of the requested Intel target, and vice versa
  it('passes the requested arch through, and rejects unsupported arch, malformed version, bad module names and empty lists before spawning', () => {
    const runner = new RecordingRunner();
    const command = new NativeRebuildCommand('/proj', '/cli.js', '/node', runner);

    command.run(['better-sqlite3'], '40.0.0', 'arm64');
    expect(runner.calls[0].args.slice(-2)).toEqual(['-a', 'arm64']);
    expect(() => command.run(['better-sqlite3'], '40.0.0', 'ia32')).toThrow(/unsupported architecture/);
    expect(() => command.run(['better-sqlite3'], '40.0.0 --evil', 'x64')).toThrow(/malformed Electron version/);
    expect(() => command.run(['better-sqlite3; rm -rf /'], '40.0.0', 'x64')).toThrow(/malformed module name/);
    expect(() => command.run([], '40.0.0', 'x64')).toThrow(/No native modules/);
    expect(runner.calls).toHaveLength(1);
  });

  // risk: a failed rebuild treated as success, shipping a stale-ABI addon
  it('throws with the exit code and stderr tail on non-zero exit, signal, timeout or spawn failure', () => {
    const make = (result: RebuildProcess) => new NativeRebuildCommand('/proj', '/cli.js', '/node', new RecordingRunner(result));

    expect(() => make({ status: 1, signal: null, stderr: 'gyp ERR! build error\nreal cause here' }).run(['better-sqlite3'], '40.0.0', 'x64')).toThrow(/exit 1.*real cause here/);
    expect(() => make({ status: null, signal: 'SIGKILL', stderr: '' }).run(['better-sqlite3'], '40.0.0', 'x64')).toThrow(/signal SIGKILL/);
    expect(() => make({ status: null, signal: null, stderr: '', error: 'spawnSync /node ETIMEDOUT' }).run(['better-sqlite3'], '40.0.0', 'x64')).toThrow(/ETIMEDOUT/);
  });

  // risk: the rebuild child itself running under tsx (the import.meta.dirname failure) or resolving a different node
  it('builds a plain-node environment: tsx hooks removed, other NODE_OPTIONS kept, the node directory first on PATH', () => {
    const command = new NativeRebuildCommand('/proj', '/cli.js', '/opt/node-x64/bin/node', new RecordingRunner());
    const env = command.env({ NODE_OPTIONS: '--max-old-space-size=4096 --import file:///x/node_modules/tsx/dist/loader.mjs -r /x/tsx/cjs.cjs', PATH: '/usr/bin', TSX_TSCONFIG_PATH: 'a', HOME: '/h' });

    expect(env.NODE_OPTIONS).toBe('--max-old-space-size=4096');
    expect(env.TSX_TSCONFIG_PATH).toBeUndefined();
    expect(env.PATH).toBe(`/opt/node-x64/bin${ path.delimiter }/usr/bin`);
    expect(env.HOME).toBe('/h');
    expect(command.env({ NODE_OPTIONS: '--import=tsx/esm', PATH: '/usr/bin' }).NODE_OPTIONS).toBeUndefined();
  });

  // bounded real-subprocess smoke: no shell, argv reaches a real node intact, failure exit propagates
  it('really spawns plain node with the argv untouched and propagates a failing exit', () => {
    const project = new TempProject().write('cli.js', 'process.stdout.write(""); require("fs").writeFileSync(process.cwd()+"/argv.json", JSON.stringify(process.argv.slice(2))); process.exit(process.env.REBUILD_FAIL ? 3 : 0);');
    const command = new NativeRebuildCommand(project.root, path.join(project.root, 'cli.js'), process.execPath, new SpawnRebuildRunner(), 20000);

    command.run(['better-sqlite3'], '40.0.0', 'x64');
    expect(JSON.parse(fs.readFileSync(path.join(project.root, 'argv.json'), 'utf8'))).toEqual(['-f', '-w', 'better-sqlite3', '-v', '40.0.0', '-a', 'x64']);
    const failing = new NativeRebuildCommand(project.root, path.join(project.root, 'missing.js'), process.execPath, new SpawnRebuildRunner(), 20000);

    expect(() => failing.run(['better-sqlite3'], '40.0.0', 'x64')).toThrow(/failed \(exit 1\)/);
  });
});

describe('NativeRebuildModules', () => {
  // risk: a source-compiled production dependency skipped once electron-builder's own rebuild is turned off
  it('always includes the required ABI addons plus production deps that compile from source and ship no prebuilds', () => {
    const project = new TempProject()
      .write('package.json', JSON.stringify({ dependencies: { 'native-reg': '1', 'node-pty': '1', 'pure-js': '1' }, optionalDependencies: { 'opt-native': '1' }, devDependencies: { 'dev-native': '1' } }))
      .write('node_modules/native-reg/binding.gyp')
      .write('node_modules/node-pty/binding.gyp')
      .write('node_modules/node-pty/prebuilds/darwin-x64/pty.node')
      .write('node_modules/pure-js/index.js')
      .write('node_modules/opt-native/binding.gyp')
      .write('node_modules/dev-native/binding.gyp');

    expect(new NativeRebuildModules(project.root).list()).toEqual(['better-sqlite3', 'native-reg', 'opt-native']);
  });
});
