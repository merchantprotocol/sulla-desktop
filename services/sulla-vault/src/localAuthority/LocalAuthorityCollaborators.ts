// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { BootstrapUnlockService } from './BootstrapUnlockService.js';
import { HumanSessionService } from './HumanSessionService.js';
import type { LocalAuthorityHost } from './LocalAuthorityHost.js';
import { VaultKeyActivation } from './VaultKeyActivation.js';

/**
 * The collaborators LocalVaultAuthority delegates to (E9). Each one holds only the host and
 * reads vault state from it at call time, so building them has no side effects.
 */
export class LocalAuthorityCollaborators {
  readonly bootstrap: BootstrapUnlockService;
  readonly keyActivation: VaultKeyActivation;
  readonly humanSessions: HumanSessionService;

  constructor(host: LocalAuthorityHost) {
    this.bootstrap = new BootstrapUnlockService(host);
    this.keyActivation = new VaultKeyActivation(host);
    this.humanSessions = new HumanSessionService(host);
  }
}
