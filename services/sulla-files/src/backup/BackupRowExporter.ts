// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';

import { BackupTableDataRepository } from '../Repositories/BackupTableDataRepository.js';
import { ExactFileWriter } from './ExactFileWriter.js';
import { SchemaEvidenceComparison } from './SchemaEvidence.js';

import type pg from 'pg';

export const ROW_BATCH = 256;
export const MAX_ROW_BYTES = 16 * 1024 * 1024;

/** Writes the snapshot's rows as `table<TAB>json<LF>` lines and copies its chunk ciphertext. */
export class BackupRowExporter {
  constructor(private readonly data = new BackupTableDataRepository()) {}

  async writeRows(client:pg.PoolClient, destination:string, tables:string[]):Promise<void> {
    const output = await open(destination, 'wx', 0o600);
    let position = 0;
    try {
      for (const table of SchemaEvidenceComparison.restorableTables(tables)) {
        await this.data.openRowCursor(client, table);
        try {
          for (;;) {
            const rows = await this.data.fetchRows(client, ROW_BATCH);
            if (!rows.length) break;
            for (const row of rows) {
              const value = Buffer.from(`${ table }\t${ row }\n`);
              if (value.length - 1 > MAX_ROW_BYTES) throw new Error('Files database row exceeds the backup format size limit');
              await ExactFileWriter.writeAll(output, value, position); position += value.length;
            }
          }
        } finally { await this.data.closeRowCursor(client) }
      }
      await output.sync();
    } finally { await output.close() }
  }

  async copyChunk(sourcePath:string, destination:string, expectedBytes:number):Promise<void> {
    for (const ancestor of [dirname(dirname(sourcePath)), dirname(sourcePath)]) {
      const info = await lstat(ancestor); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Chunk store contains an unsafe path type');
    }
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW); const output = await open(destination, 'wx', 0o600);
    let offset = 0;
    try {
      const before = await source.stat(); if (!before.isFile() || before.size !== expectedBytes) throw new Error('Chunk ciphertext does not match its database inventory');
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      while (offset < expectedBytes) {
        const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, expectedBytes - offset), offset);
        if (!bytesRead) throw new Error('Chunk ciphertext was truncated during backup');
        await ExactFileWriter.writeAll(output, buffer.subarray(0, bytesRead), offset); offset += bytesRead;
      }
      const after = await source.stat(); if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('Chunk ciphertext changed during backup');
      await output.sync();
    } finally { await Promise.allSettled([source.close(), output.close()]) }
  }
}
