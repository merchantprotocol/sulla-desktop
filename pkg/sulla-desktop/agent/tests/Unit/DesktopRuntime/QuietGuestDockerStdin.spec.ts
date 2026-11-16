// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ChildProcess, SpawnOptions } from 'child_process';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

import { describe, expect, it } from 'vitest';

import { QuietGuestDockerStdin } from '@pkg/backend/QuietGuestDockerStdin';

/** A child process whose stdin is captured and whose exit is scripted. */
class FakeProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  stdinText = '';
  killedWith?: string;

  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => { this.stdinText += chunk.toString('utf-8'); });
  }

  kill(signal: string) {
    this.killedWith = signal;

    return true;
  }

  exit(code: number, stdout = '', stderr = '') {
    this.stdout.end(stdout);
    this.stderr.end(stderr);
    setImmediate(() => this.emit('close', code, null));
  }
}

function runner(timeoutMs = 1_000) {
  const spawned: { command: string, args: string[], options: SpawnOptions, proc: FakeProcess }[] = [];
  const docker = new QuietGuestDockerStdin('/bin/sulla-runtime', command => ['exec', '--', ...command], (command, args, options) => {
    const proc = new FakeProcess();

    spawned.push({ command, args, options, proc });

    return proc as unknown as ChildProcess;
  }, timeoutMs, {});

  return { docker, spawned };
}

describe('QuietGuestDockerStdin', () => {
  // risk: secret exposure — values travel on stdin, never in argv
  it('feeds the input on stdin and keeps it out of the arguments', async() => {
    const { docker, spawned } = runner();
    const pending = docker.run(['exec', '-i', 'sulla_postgres', 'sh', '-c', 'cat'], 'the-secret');

    await new Promise(resolve => setImmediate(resolve));
    spawned[0].proc.exit(0, '1\n');

    expect(await pending).toEqual({ code: 0, stdout: '1\n', stderr: '' });
    expect(spawned[0].command).toBe('/bin/sulla-runtime');
    expect(spawned[0].args).toEqual(['exec', '--', 'docker', 'exec', '-i', 'sulla_postgres', 'sh', '-c', 'cat']);
    expect(spawned[0].args.join(' ')).not.toContain('the-secret');
    expect(spawned[0].proc.stdinText).toBe('the-secret');
  });

  // risk: data accuracy — callers classify failures by exit code and stderr (e.g. 28P01)
  it('resolves a failing command with its exit code and stderr instead of throwing', async() => {
    const { docker, spawned } = runner();
    const pending = docker.run(['exec', 'sulla_postgres', 'psql']);

    await new Promise(resolve => setImmediate(resolve));
    spawned[0].proc.exit(2, '', 'FATAL:  password authentication failed for user "sulla"');

    expect(await pending).toEqual({ code: 2, stdout: '', stderr: 'FATAL:  password authentication failed for user "sulla"' });
  });

  // risk: availability — a hung guest call never hangs boot
  it('kills a call that outlives the timeout with SIGKILL and rejects', async() => {
    const { docker, spawned } = runner(20);

    await expect(docker.run(['exec', 'sulla_postgres', 'psql'])).rejects.toThrow(/did not answer/);
    expect(spawned[0].proc.killedWith).toBe('SIGKILL');
  });

  // risk: availability — a binary that cannot start is a failure, not a success with empty output
  it('rejects when the process cannot start', async() => {
    const { docker, spawned } = runner();
    const pending = docker.run(['ps']);

    spawned[0].proc.emit('error', new Error('spawn ENOENT'));
    await expect(pending).rejects.toThrow('spawn ENOENT');
  });
});
