// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { agentPolicyFromLegacyLlmAccess, type VaultItemPlaintext } from '@sulla/vault-crypto';

import type { LegacyMigrationResponse } from '../contracts.js';
import { trustedOriginsForIntegration } from '../operationPolicy.js';
import type { LocalAuthorityHost } from './LocalAuthorityHost.js';
import type { LegacyIntegrationRow } from './LocalAuthorityTypes.js';
import { LocalVaultError } from './LocalVaultError.js';

const { Pool } = pg;
import { LocalAuthorityCrypto } from './LocalAuthorityCrypto.js';

/**
 * One-shot import of the legacy Desktop credential tables into sealed vault items, idempotent by
 * source fingerprint and rolled back as a whole on any failure.
 * Moved verbatim from LocalVaultAuthority (E9); vault state lives on the host.
 */
export class LegacyMigrationService {
  constructor(private readonly host: LocalAuthorityHost) {}

  async migrateLegacy(callerId: string, token: string | undefined): Promise<LegacyMigrationResponse> {
    return this.host.runSecurityOperation(() => this.migrateLegacyInternal(callerId, token));
  }

  private async migrateLegacyInternal(callerId: string, token: string | undefined): Promise<LegacyMigrationResponse> {
    this.host.requireControlIdentity(callerId, token);
    const keys = this.host.requireKeys();
    const generation = this.host.generation;
    if (!this.host.config.legacyDatabaseUrl) {
      this.host.migrationState = 'unlocked';
      return { batchId: 'not-required', imported: 0, skipped: 0, state: 'unlocked' };
    }

    const legacy = new Pool({ connectionString: this.host.config.legacyDatabaseUrl, max: 1 });
    legacy.on('error', () => { /* idle client dropped; this one-shot pool is ended below */ });
    let rows: LegacyIntegrationRow[] = [];
    try {
      const client = await legacy.connect();
      try {
        await this.host.localStore.beginReadOnly(client);
        const result = await this.host.legacyCredentialRepository.list(client);
        rows = result.rows;
        await this.host.localStore.commit(client);
      } catch (error) {
        await this.host.localStore.rollback(client);
        throw error;
      } finally {
        client.release();
      }
    } catch {
      this.host.migrationState = 'migration_failed';
      throw new LocalVaultError('migration_failed', 409, 'Legacy credential source could not be read');
    } finally {
      await legacy.end().catch(() => undefined);
    }

    const sourceFingerprint = LocalAuthorityCrypto.stableLegacyFingerprint(rows);
    const already = await this.host.migrationRepository.findCommitted<{ id: string; imported_count: number; skipped_count: number }>(sourceFingerprint);
    if (already.rowCount) {
      this.host.requireGeneration(generation);
      this.host.migrationState = 'unlocked';
      return { batchId: already.rows[0].id, imported: 0, skipped: rows.length, state: 'unlocked' };
    }

    const groups = new Map<string, LegacyIntegrationRow[]>();
    for (const row of rows) {
      const key = `${ row.integration_id }\0${ row.account_id }`;
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }

    const client = await this.host.db.connect();
    let batchId = '';
    try {
      await this.host.localStore.begin(client);
      await this.host.localStore.lockLegacyImport(client);
      const batch = await this.host.migrationRepository.start<{ id: string }>(sourceFingerprint, client);
      batchId = batch.rows[0].id;
      let imported = 0;
      let skipped = 0;
      for (const groupRows of groups.values()) {
        this.host.requireGeneration(generation);
        const { integration_id: integrationId, account_id: accountId } = groupRows[0];
        const existing = await this.host.itemRepository.findLegacyIntegrationItem([`${ integrationId }/${ accountId }`, keys.userId], client);
        if (existing.rowCount) {
          skipped += groupRows.length;
          continue;
        }
        const properties: Record<string, string> = {};
        for (const row of groupRows) properties[row.property] = LocalAuthorityCrypto.decryptLegacyValue(row.value, keys.legacyVmk);
        const policy = agentPolicyFromLegacyLlmAccess(properties.llm_access);
        const sites = new Set(trustedOriginsForIntegration(integrationId));
        for (const property of ['base_url', 'server_url', 'gateway_url', 'url', 'endpoint']) {
          const raw = properties[property];
          if (!raw) continue;
          try {
            const url = new URL(raw);
            if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash) sites.add(url.hostname.toLowerCase());
          } catch { /* An invalid legacy URL is not promoted into broker policy. */ }
        }
        policy.sites = [...sites];
        const itemId = randomUUID();
        const plaintext: VaultItemPlaintext = {
          type: 'apiKey',
          name: `${ integrationId } (${ accountId })`,
          integration: { integrationId, accountId, properties },
          agentPolicy: policy,
        };
        const encrypted = await this.host.sealItem(JSON.stringify(plaintext), keys.userKey, { itemId, ownerId: keys.userId });
        const reopened = await this.host.openItemText(encrypted, keys.userKey, { itemId, ownerId: keys.userId });
        if (reopened !== JSON.stringify(plaintext)) {
          throw new LocalVaultError('migration_failed', 409, 'Migrated item failed reopen verification');
        }
        await this.host.itemRepository.insertMigratedLegacyItem([itemId, keys.userId, encrypted.ciphertext, encrypted.encryptedItemKey, policy, `${ integrationId }/${ accountId }`], client);
        for (const row of groupRows) {
          await this.host.migrationRepository.addRow([row.source_kind, row.value_id, sourceFingerprint, itemId], client);
        }
        imported += groupRows.length;
      }
      this.host.requireGeneration(generation);
      await this.host.migrationRepository.commit(batchId, imported, skipped, client);
      await this.host.localStore.commit(client);
      keys.legacyVmk?.fill(0);
      keys.legacyVmk = undefined;
      this.host.migrationState = 'unlocked';
      return { batchId, imported, skipped, state: 'unlocked' };
    } catch (error) {
      await this.host.localStore.rollback(client);
      this.host.migrationState = 'migration_failed';
      if (batchId) {
        await this.host.migrationRepository.fail(batchId).catch(() => undefined);
      }
      if (error instanceof LocalVaultError) throw error;
      throw new LocalVaultError('migration_failed', 409, 'Legacy migration rolled back');
    } finally {
      client.release();
    }
  }
}
