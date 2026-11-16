// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Type-only import: erased at compile time, so no runtime cycle with recoveryKeychain or sullaCloudAuth.
import type { recoveryKeyStorageStatus } from '../../recoveryKeychain';

export interface CloudRecoveryKeyNotice {
  recoveryKey: string;
  storage: ReturnType<typeof recoveryKeyStorageStatus>;
  madeAt: string;
}

/** Holds the one recovery key the owner has not acknowledged yet, in process memory only. */
export class CloudRecoveryKeyNoticeStore {
  private notice: CloudRecoveryKeyNotice | undefined;

  constructor(private readonly clock: () => Date = () => new Date()) {}

  publish(recoveryKey: string, storage: CloudRecoveryKeyNotice['storage']): CloudRecoveryKeyNotice {
    this.notice = { recoveryKey, storage, madeAt: this.clock().toISOString() };
    return this.notice;
  }

  pending(): CloudRecoveryKeyNotice | undefined {
    return this.notice;
  }

  clear(): void {
    this.notice = undefined;
  }
}
