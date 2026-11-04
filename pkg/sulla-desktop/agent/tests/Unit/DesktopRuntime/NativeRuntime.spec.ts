// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import { NativeRuntime, RuntimeProcessSpawner } from '@pkg/backend/sullaRuntime/NativeRuntime';
import type { SullaRuntimeArtifacts } from '@pkg/backend/sullaRuntime/artifacts';

class FakeRuntimeProcessSpawner implements RuntimeProcessSpawner {
  readonly spawnCalls: Array<{ binary: string; args: string[]; options: SpawnOptions }> = [];
  readonly child = this.createChild();

  spawn(binary: string, args: string[], options: SpawnOptions): ChildProcess {
    this.spawnCalls.push({ binary, args, options });
    queueMicrotask(() => this.child.stdout!.write('docker-ready\n'));

    return this.child;
  }

  async spawnFile(_binary: string, args: string[]): Promise<{ stdout: string }> {
    if (args[0] === 'stop') this.child.kill?.('SIGTERM');
    return { stdout: '' };
  }

  private createChild(): ChildProcess {
    const child = new PassThrough() as PassThrough & Partial<ChildProcess>;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 123;
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => {
      child.exitCode = 0;
      child.emit('exit', 0, null);
      return true;
    };

    return child as ChildProcess;
  }
}

describe('NativeRuntime instance isolation', () => {
  const originalInstance = process.env.SULLA_INSTANCE;
  const originalRuntimeDirectory = process.env.SULLA_RUNTIME_DIR;

  afterEach(() => {
    if (originalInstance === undefined) delete process.env.SULLA_INSTANCE;
    else process.env.SULLA_INSTANCE = originalInstance;
    if (originalRuntimeDirectory === undefined) delete process.env.SULLA_RUNTIME_DIR;
    else process.env.SULLA_RUNTIME_DIR = originalRuntimeDirectory;
  });

  it('passes the named instance runtime directory to the host process', async () => {
    // risk: tenant/runtime isolation — named instances must not share sockets with Sulla.
    process.env.SULLA_INSTANCE = 'firstrun-test';
    delete process.env.SULLA_RUNTIME_DIR;
    const spawner = new FakeRuntimeProcessSpawner();
    const runtime = new NativeRuntime({
      binary: '/tmp/sulla-runtime',
      kernel: '/tmp/vmlinuz',
      initrd: '/tmp/initramfs.img',
      usrImage: '/tmp/usr.erofs',
    } satisfies SullaRuntimeArtifacts, spawner);

    await runtime.start({ dataDisk: '/tmp/data.img', cpus: 1, memoryMiB: 512, shares: [] });

    expect(spawner.spawnCalls[0]?.options.env?.SULLA_RUNTIME_DIR).toMatch(/Sulla-firstrun-test[\\/]runtime$/);
    await runtime.stop();
  });
});
