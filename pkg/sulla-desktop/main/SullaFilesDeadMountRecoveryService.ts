// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { VMExecutor } from '@pkg/backend/backend';
import { drainFilesAdapterLayers, SULLA_FILES_GUEST_MOUNT_PATH } from '@pkg/backend/guestMountInfo';

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
    if (state !== 'ENOTCONN' && state !== 'TIMEOUT') return;

    // Shared-parent propagation can leave repeated identical FUSE layers at
    // this mountpoint. Drain each top layer, not just the first stale copy.
    await drainFilesAdapterLayers(this.executor, SULLA_FILES_GUEST_MOUNT_PATH);
    const verified = await this.statState();
    if (verified === 'ENOTCONN' || verified === 'TIMEOUT') throw new Error(`The dead Files mount still reports ${ verified } after lazy unmount`);
  }

  /**
   * Stat the Files mount under a timeout: a live-but-stuck FUSE daemon blocks stat forever.
   * A timeout (exit 124) or empty output means the mount is stuck, so it is reported as TIMEOUT.
   */
  private async statState():Promise<string> {
    const output = await this.executor.execCommand(
      { root: true, capture: true, expectFailure: true }, 'timeout', '10', 'python3', '-c', STAT_ERROR, SULLA_FILES_GUEST_MOUNT_PATH,
    ).catch(() => '');
    return output.trim() || 'TIMEOUT';
  }
}
