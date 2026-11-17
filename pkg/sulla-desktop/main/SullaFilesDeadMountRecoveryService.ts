// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { VMExecutor } from '@pkg/backend/backend';
import { SULLA_FILES_GUEST_MOUNT_PATH } from '@pkg/backend/guestMountInfo';

const STAT_ERROR = 'import errno,os,sys;\ntry: os.stat(sys.argv[1]); print("ok")\nexcept OSError as e: print(errno.errorcode.get(e.errno, "ERROR"))';

/** Detaches a stale VM FUSE mount before Docker inspects/recreates its bind. */
export class SullaFilesDeadMountRecoveryService {
  constructor(private readonly executor:VMExecutor) {}

  async recreateAndReattach(recreate:() => Promise<void>, reattach:() => Promise<void>):Promise<void> {
    await this.clearDeadMount();
    await recreate();
    await reattach();
  }

  async clearDeadMount():Promise<void> {
    const state = await this.statState();
    if (state !== 'ENOTCONN') return;

    await this.executor.execCommand({ root: true, expectFailure: true }, 'fusermount3', '-uz', SULLA_FILES_GUEST_MOUNT_PATH).catch(() => undefined);
    if (await this.statState() === 'ENOTCONN') {
      await this.executor.execCommand({ root: true, expectFailure: true }, 'umount', '-l', SULLA_FILES_GUEST_MOUNT_PATH).catch(() => undefined);
    }
    const verified = await this.statState();
    if (verified === 'ENOTCONN') throw new Error('The dead Files mount still reports ENOTCONN after lazy unmount');
  }

  private async statState():Promise<string> {
    return (await this.executor.execCommand(
      { root: true, capture: true }, 'python3', '-c', STAT_ERROR, SULLA_FILES_GUEST_MOUNT_PATH,
    )).trim();
  }
}
