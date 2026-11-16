// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { CloudSessionKeyStore } from './CloudSessionKeyStore';

/** Main-process binding for the transient Cloud-derived vault key store. */
export class CloudSessionKeyServiceProvider {
  readonly keys: CloudSessionKeyStore;

  constructor(keys: CloudSessionKeyStore = new CloudSessionKeyStore()) {
    this.keys = keys;
  }
}

export const cloudSessionKeyProvider = new CloudSessionKeyServiceProvider();
