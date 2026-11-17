import { describe, expect, it } from 'vitest';

import type { VMExecutor } from '@pkg/backend/backend';
import { SullaFilesDeadMountRecoveryService } from './SullaFilesDeadMountRecoveryService.ts';

class FakeExecutor {
  readonly events:string[] = [];
  private stats:string[];

  constructor(stats:string[]) { this.stats = [...stats] }

  async execCommand(options:{ capture?: boolean }, ...command:string[]):Promise<string | void> {
    if (command[0] === 'python3') {
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

    expect(executor.events).toEqual(['stat', 'lazy-unmount-fuse', 'stat', 'stat', 'recreate', 'reattach']);
  });

  it('never recreates while the mount still reports ENOTCONN after both lazy-unmount attempts', async() => {
    // risk: availability — recreating with a poisoned bind reproduces the multi-minute dead-mount failure.
    const executor = new FakeExecutor(['ENOTCONN', 'ENOTCONN', 'ENOTCONN']);
    const recovery = new SullaFilesDeadMountRecoveryService(executor.asVm());
    const recreate = async() => { executor.events.push('recreate') };

    await expect(recovery.recreateAndReattach(recreate, async() => undefined)).rejects.toThrow('still reports ENOTCONN');
    expect(executor.events).toEqual(['stat', 'lazy-unmount-fuse', 'stat', 'lazy-unmount-fallback', 'stat']);
  });
});
