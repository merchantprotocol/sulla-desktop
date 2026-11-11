// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { PostgresSullaCloudRevocationRepository } from '../repositories/PostgresSullaCloudRevocationRepository.js';
import type { PostgresIntegrationStateRepository } from '../repositories/PostgresVaultAuthorityRepositories.js';
import type { PostgresVaultItemRepository } from '../repositories/PostgresVaultItemRepositories.js';
import { CredentialQueueRefreshLock, type CredentialSerializer } from './CredentialQueueRefreshLock.js';
import { PostgresSullaCloudItemGateway, type SullaCloudVaultContext } from './PostgresSullaCloudItemGateway.js';
import { SullaCloudSessionManager } from './SullaCloudSessionManager.js';
import { VaultCloudAccountTransport, type SullaCloudHttpPort } from './VaultCloudAccountTransport.js';
import { VaultItemTokenStore } from './VaultItemTokenStore.js';
import { VaultRevocationQueue } from './VaultRevocationQueue.js';

export interface SullaCloudSessionDependencies extends SullaCloudHttpPort {
  items:       PostgresVaultItemRepository;
  state:       PostgresIntegrationStateRepository;
  revocations: PostgresSullaCloudRevocationRepository;
  serialize:   CredentialSerializer;
}

/** Wires the vault's Sulla Cloud session classes together (item store, lock, transport, durable queue). */
export class SullaCloudSessionManagerFactory {
  constructor(
    private readonly vault: SullaCloudVaultContext,
    private readonly dependencies: SullaCloudSessionDependencies,
  ) {}

  create(): SullaCloudSessionManager {
    const { items, state, revocations, serialize } = this.dependencies;
    return new SullaCloudSessionManager(
      new VaultItemTokenStore(new PostgresSullaCloudItemGateway(this.vault, items, state)),
      new VaultCloudAccountTransport(this.dependencies),
      new CredentialQueueRefreshLock(serialize),
      new VaultRevocationQueue(revocations, this.vault),
    );
  }
}
