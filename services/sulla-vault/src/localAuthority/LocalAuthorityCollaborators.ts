// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { BootstrapUnlockService } from './BootstrapUnlockService.js';
import { HumanSessionService } from './HumanSessionService.js';
import { HumanItemService } from './HumanItemService.js';
import { BitwardenImportService } from './BitwardenImportService.js';
import { AccountPasswordService } from './AccountPasswordService.js';
import { HumanRecoveryService } from './HumanRecoveryService.js';
import { VaultEnrollmentService } from './VaultEnrollmentService.js';
import { AgentItemWriter } from './AgentItemWriter.js';
import { IntegrationAccountService } from './IntegrationAccountService.js';
import { LegacyMigrationService } from './LegacyMigrationService.js';
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
  readonly humanItems: HumanItemService;
  readonly bitwarden: BitwardenImportService;
  readonly accountPasswords: AccountPasswordService;
  readonly recovery: HumanRecoveryService;
  readonly enrollment: VaultEnrollmentService;
  readonly agentItems: AgentItemWriter;
  readonly integrations: IntegrationAccountService;
  readonly legacyMigration: LegacyMigrationService;

  constructor(host: LocalAuthorityHost) {
    this.bootstrap = new BootstrapUnlockService(host);
    this.keyActivation = new VaultKeyActivation(host);
    this.humanSessions = new HumanSessionService(host);
    this.humanItems = new HumanItemService(host);
    this.bitwarden = new BitwardenImportService(host);
    this.accountPasswords = new AccountPasswordService(host);
    this.recovery = new HumanRecoveryService(host);
    this.enrollment = new VaultEnrollmentService(host);
    this.agentItems = new AgentItemWriter(host);
    this.integrations = new IntegrationAccountService(host);
    this.legacyMigration = new LegacyMigrationService(host);
  }
}
