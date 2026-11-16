// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash, randomUUID } from 'node:crypto';

import type { VaultItemPlaintext } from '@sulla/vault-crypto';

import type { BitwardenExportUpload, BitwardenImportPreview } from '../bitwarden/BitwardenExportImporter.js';
import type { LocalAuthorityHost } from './LocalAuthorityHost.js';
import type { ItemRow } from './LocalAuthorityTypes.js';
import { LocalVaultError } from './LocalVaultError.js';

/**
 * Bitwarden export preview and import into the unlocked personal vault, with duplicate
 * detection against existing items and within the export.
 * Moved verbatim from LocalVaultAuthority (E9); vault state lives on the host.
 */
export class BitwardenImportService {
  constructor(private readonly host: LocalAuthorityHost) {}

  async previewBitwardenImport(sessionId: string|undefined, csrf: string|undefined, input: { content:string; format:'json'|'csv'|'zip'; password?:string }): Promise<BitwardenImportPreview & { duplicates:number; importable:number }> {
    return this.host.runSecurityOperation(async()=> (await this.prepareBitwardenImport(sessionId,csrf,input)).preview);
  }

  async importBitwarden(sessionId: string|undefined, csrf: string|undefined, input: { content:string; format:'json'|'csv'|'zip'; password?:string }): Promise<BitwardenImportPreview & { duplicates:number; importable:number; imported:number }> {
    return this.host.runSecurityOperation(async()=>{
      const prepared=await this.prepareBitwardenImport(sessionId,csrf,input);
      await this.host.runTransaction(async client => { for(const item of prepared.items){ const id=randomUUID(); const encrypted=await this.host.sealItem(JSON.stringify(item),prepared.keys.userKey,{itemId:id,ownerId:prepared.keys.userId}); await this.host.itemRepository.insertImportedItem([id,prepared.keys.userId,item.type,encrypted.ciphertext,encrypted.encryptedItemKey,item.agentPolicy], client); } });
      this.host.requireGeneration(prepared.generation);
      await this.host.auditHumanAction(this.host.db,prepared.keys.userId,'human_bitwarden_import');
      return {...prepared.preview,imported:prepared.items.length};
    });
  }

  private async prepareBitwardenImport(
    sessionId: string | undefined, csrf: string | undefined,
    input: { content: string; format: 'json'|'csv'|'zip'; password?: string },
  ): Promise<{ preview: BitwardenImportPreview & { duplicates: number; importable: number }; items: VaultItemPlaintext[]; keys: { userId: string; userKey: Uint8Array }; generation: number }> {
    const session = this.host.validateHumanSession(sessionId, csrf);
    if (session.phase !== 'unlocked') throw new LocalVaultError('vault_locked', 423, 'Vault is locked');
    const maxContent = input.format === 'zip' ? 34 * 1024 * 1024 : 25 * 1024 * 1024;
    if (typeof input.content !== 'string' || Buffer.byteLength(input.content) > maxContent) throw new LocalVaultError('invalid_operation', 400, 'Bitwarden exports are limited to 25 MB');
    const keys = this.host.requireKeys(), generation = this.host.generation;
    const mapped = await this.readBitwardenExport(input);
    const rows = await this.host.itemRepository.listOwnedActiveForImport<ItemRow>([keys.userId]);
    const existing = new Set<string>();
    for (const row of rows.rows) {
      const item = JSON.parse(await this.host.openItemText({ version:1, ciphertext:row.ciphertext, encryptedItemKey:row.encrypted_item_key }, keys.userKey, { itemId:row.id, ownerId:keys.userId })) as VaultItemPlaintext;
      existing.add(this.bitwardenDedupeKey(item));
    }
    const seen = new Set(existing); let duplicates = 0;
    const items = mapped.items.filter(item => { const key=this.bitwardenDedupeKey(item); if(seen.has(key)){duplicates++;return false;} seen.add(key);return true; });
    this.host.requireGeneration(generation);
    return { preview:{ counts:mapped.counts,total:mapped.total,unmapped:mapped.unmapped,warnings:mapped.warnings,duplicates,importable:items.length }, items, keys, generation };
  }

  /** Parses through @sulla/domain; its failures become route errors ({ error: code }, 400). */
  private async readBitwardenExport(input: BitwardenExportUpload) {
    try {
      return await this.host.bitwardenImporter.read(input);
    } catch (error) {
      if (this.host.bitwardenImporter.isImportFailure(error)) throw new LocalVaultError(error.code, 400, error.message);
      throw error;
    }
  }

  private bitwardenDedupeKey(item: VaultItemPlaintext): string {
    const sourceId = item.sourceMetadata?.source === 'bitwarden' && item.sourceMetadata.sourceId;
    if (sourceId) return `bitwarden:${sourceId}`;
    return `content:${createHash('sha256').update(JSON.stringify([item.type,item.name,item.username,item.password,item.totp,item.uris,item.card,item.identity,item.sshKey])).digest('hex')}`;
  }
}
