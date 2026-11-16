// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { inflateRawSync } from 'node:zlib';

import { BitwardenImportException, BitwardenZipReader } from '@sulla/domain';

type Json = Record<string, any>;

/**
 * The domain ZIP reader plus the attachment files Desktop has always stored.
 *
 * `BitwardenZipReader` (domain) reads and validates the archive (size, entry,
 * total and compression-ratio limits) and decrypts its JSON export, but drops
 * every other entry. Desktop's pre-domain importer inlined those files into the
 * matching item: for each item attachment whose `id` appears in an entry path,
 * `attachment.data` = the file bytes as base64 and `attachment.zipPath` = the
 * entry path (first matching entry in directory order). This class restores
 * exactly that, after the domain reader has accepted the archive, so its limits
 * still apply. Nothing is written to disk.
 */
export class BitwardenZipAttachmentReader extends BitwardenZipReader {
  private static readonly exportEntry = [/(^|\/)data\.json$/i, /(^|\/)bitwarden.*\.json$/i];

  override read(zip: Uint8Array, password?: string): Json {
    const json = super.read(zip, password);
    try {
      this.inline(json, this.files(Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength)));
    } catch (error) {
      if (error instanceof BitwardenImportException) throw error;
      throw new BitwardenImportException('Choose a valid Bitwarden ZIP export.');
    }
    return json;
  }

  /** Every file entry except the export JSON, in central-directory order: path -> base64 bytes. */
  private files(zip: Buffer): Map<string, string> {
    const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const count = zip.readUInt16LE(end + 10), files = new Map<string, string>();
    let offset = zip.readUInt32LE(end + 16);
    for (let index = 0; index < count; index += 1) {
      const method = zip.readUInt16LE(offset + 10), compressedSize = zip.readUInt32LE(offset + 20), expandedSize = zip.readUInt32LE(offset + 24);
      const nameLength = zip.readUInt16LE(offset + 28), extraLength = zip.readUInt16LE(offset + 30), commentLength = zip.readUInt16LE(offset + 32), local = zip.readUInt32LE(offset + 42);
      const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
      offset += 46 + nameLength + extraLength + commentLength;
      if (name.endsWith('/') || BitwardenZipAttachmentReader.exportEntry.some(pattern => pattern.test(name))) continue;
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const stored = zip.subarray(start, start + compressedSize);
      // The domain reader already enforced method 0/8 and the size limits on every entry.
      const data = method === 0 ? stored : inflateRawSync(stored, { maxOutputLength: Math.max(expandedSize, 1) });
      files.set(name, data.toString('base64'));
    }
    return files;
  }

  private inline(json: Json, files: Map<string, string>): void {
    for (const item of Array.isArray(json?.items) ? json.items : []) {
      for (const attachment of Array.isArray(item?.attachments) ? item.attachments : []) {
        const id = String(attachment?.id ?? '');
        const match = id ? [...files].find(([path]) => path.includes(id)) : undefined;
        if (match) {
          attachment.data = match[1];
          attachment.zipPath = match[0];
        }
      }
    }
  }
}
