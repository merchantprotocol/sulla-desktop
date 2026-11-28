// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';

import type { VMExecutor } from '@pkg/backend/backend';
import { SullaFilesDeadMountRecoveryService } from './SullaFilesDeadMountRecoveryService.ts';

class FakeExecutor {
  readonly events:string[] = [];
  private stats:string[];

  constructor(stats:string[]) { this.stats = [...stats] }

  async execCommand(options:{ capture?: boolean }, ...command:string[]):Promise<string | void> {
    if (command[0] === 'timeout') {
      this.events.push('stat');
      return this.stats.shift() ?? 'ok';
    }
    if (command[0] === 'fusermount3') this.events.push('lazy-unmount-fuse');
    else if (command[0] === 'umount') this.events.push('lazy-unmount-fallback');
  }

  asVm():VMExecutor { return this as unknown as VMExecutor }
}

describe('SullaFilesDeadMountRecoveryService', () => {
  it('clears ENOTCONN before container recreate and agent re-attach', async() => {
    // risk: availability — Docker must not inspect a dead bind mount and leave Files unavailable for minutes.
    const executor = new FakeExecutor(['ENOTCONN', 'ok', 'ok']);
    const recovery = new SullaFilesDeadMountRecoveryService(executor.asVm());

    await recovery.recreateAndReattach(async() => { executor.events.push('recreate') }, async() => { executor.events.push('reattach') });

    expect(executor.events).toEqual(['stat', 'lazy-unmount-fuse', 'stat', 'recreate', 'reattach']);
  });

  it('lazy-unmounts a stat that times out on a stuck FUSE mount before recreate', async() => {
    // risk: availability — a live-but-stuck FUSE daemon hangs stat; Docker must not inspect that bind.
    const executor = new FakeExecutor(['TIMEOUT', 'ok', 'ok']);
    const recovery = new SullaFilesDeadMountRecoveryService(executor.asVm());

    await recovery.recreateAndReattach(async() => { executor.events.push('recreate') }, async() => { executor.events.push('reattach') });

    expect(executor.events).toEqual(['stat', 'lazy-unmount-fuse', 'stat', 'recreate', 'reattach']);
  });

  it('falls back to lazy umount when fusermount3 is missing and the stuck mount still times out', async() => {
    // risk: availability — the VM guest may lack fusermount3; a stuck (TIMEOUT) mount must still be detached, not left to throw.
    const executor = new FakeExecutor(['TIMEOUT', 'TIMEOUT', 'ok']);
    const recovery = new SullaFilesDeadMountRecoveryService(executor.asVm());

    await recovery.recreateAndReattach(async() => { executor.events.push('recreate') }, async() => { executor.events.push('reattach') });

    expect(executor.events).toEqual(['stat', 'lazy-unmount-fuse', 'stat', 'lazy-unmount-fallback', 'stat', 'recreate', 'reattach']);
  });

  it('detaches two stacked dead layers before recreating', async() => {
    // risk: availability — one stale layer must not conceal a second dead FUSE layer from Docker.
    const executor = new FakeExecutor(['ENOTCONN', 'ENOTCONN', 'ENOTCONN', 'ENOTCONN', 'ok', 'ok']);
    const recovery = new SullaFilesDeadMountRecoveryService(executor.asVm());

    await recovery.recreateAndReattach(async() => { executor.events.push('recreate') }, async() => { executor.events.push('reattach') });

    expect(executor.events).toEqual([
      'stat', 'lazy-unmount-fuse', 'stat', 'lazy-unmount-fallback', 'stat',
      'lazy-unmount-fuse', 'stat', 'lazy-unmount-fallback', 'stat', 'recreate', 'reattach',
    ]);
  });

  it('never recreates when all eight detach rounds still report ENOTCONN', async() => {
    // risk: availability — recreating with a poisoned bind reproduces the multi-minute dead-mount failure.
    const executor = new FakeExecutor(Array.from({ length: 17 }, () => 'ENOTCONN'));
    const recovery = new SullaFilesDeadMountRecoveryService(executor.asVm());
    const recreate = async() => { executor.events.push('recreate') };

    await expect(recovery.recreateAndReattach(recreate, async() => undefined)).rejects.toThrow('still reports ENOTCONN');
    expect(executor.events.filter(event => event === 'lazy-unmount-fuse')).toHaveLength(8);
    expect(executor.events.filter(event => event === 'lazy-unmount-fallback')).toHaveLength(8);
    expect(executor.events).not.toContain('recreate');
  });
});
