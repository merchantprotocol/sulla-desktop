// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { CloudRecoveryKeyNoticeStore } from './CloudRecoveryKeyNoticeStore';

/** Main-process binding for the unacknowledged recovery-key notice. */
export class CloudRecoveryKeyServiceProvider {
  readonly notices: CloudRecoveryKeyNoticeStore;

  constructor(notices: CloudRecoveryKeyNoticeStore = new CloudRecoveryKeyNoticeStore()) {
    this.notices = notices;
  }
}

export const cloudRecoveryKeyProvider = new CloudRecoveryKeyServiceProvider();
