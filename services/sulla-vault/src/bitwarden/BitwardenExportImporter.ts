// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { webcrypto } from 'node:crypto';

import { BitwardenImportException, BitwardenImportService, WebCryptoRandomSource, type BitwardenImportResult } from '@sulla/domain';
import type { VaultItemPlaintext } from '@sulla/vault-crypto';

export type BitwardenExportFormat = 'json' | 'csv' | 'zip';

/** What the Desktop console uploads: JSON/CSV as text, ZIP as base64. */
export interface BitwardenExportUpload { content: string; format: BitwardenExportFormat; password?: string }

export interface BitwardenImportPreview { counts: Record<string, number>; total: number; unmapped: Array<{ sourceId?: string; reason: string }>; warnings: string[] }
export interface BitwardenExportItems extends BitwardenImportPreview { items: VaultItemPlaintext[] }

/**
 * Desktop adapter over @sulla/domain BitwardenImportService, the only Bitwarden
 * parser (decryption, ZIP, CSV and item mapping all live there).
 *
 * It only translates the Desktop upload (base64 ZIP) and keeps the stored item
 * shape Desktop has always written:
 * - provenance keeps the Bitwarden ids and dates, not the raw login/card/identity/
 *   sshKey/fields records, so no second copy of a secret outlives an edit;
 * - CSV rows have no Bitwarden id, so the domain's positional `csv-N` ids are
 *   dropped and Desktop dedupes CSV rows by content, as before.
 *
 * Domain failures surface as BitwardenImportException with codes
 * password_required, wrong_password, account_restricted or invalid_export.
 */
export class BitwardenExportImporter {
  private static readonly provenanceFields = ['source', 'sourceId', 'folderId', 'organizationId', 'collectionIds', 'reprompt', 'createdAt', 'revisedAt', 'deletedAt', 'attachments'] as const;

  constructor(private readonly service: BitwardenImportService = new BitwardenImportService(new WebCryptoRandomSource(webcrypto as unknown as Crypto))) {}

  read(upload: BitwardenExportUpload): BitwardenExportItems {
    const result = this.parse(upload);
    const items = result.items.map(item => this.toDesktopItem(item as unknown as VaultItemPlaintext, upload.format));
    return { items, counts: result.counts, total: result.total, unmapped: result.unmapped, warnings: result.warnings };
  }

  isImportFailure(error: unknown): error is BitwardenImportException & { code: string } {
    return error instanceof BitwardenImportException;
  }

  private parse(upload: BitwardenExportUpload): BitwardenImportResult {
    if (upload.format === 'zip') return this.service.import(new Uint8Array(Buffer.from(upload.content, 'base64')), { format: 'zip', password: upload.password });
    return this.service.import(upload.content, { format: upload.format === 'csv' ? 'csv' : 'json', password: upload.password });
  }

  private toDesktopItem(item: VaultItemPlaintext, format: BitwardenExportFormat): VaultItemPlaintext {
    const source = (item.sourceMetadata ?? {}) as Record<string, unknown>;
    const provenance: Record<string, unknown> = {};
    for (const field of BitwardenExportImporter.provenanceFields) provenance[field] = source[field];
    if (format === 'csv') provenance.sourceId = undefined;
    return { ...item, sourceMetadata: provenance as VaultItemPlaintext['sourceMetadata'] };
  }
}
