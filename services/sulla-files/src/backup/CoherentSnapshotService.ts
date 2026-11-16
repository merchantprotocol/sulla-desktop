// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { join } from 'node:path';

import { BackupInventoryRepository } from '../Repositories/BackupInventoryRepository.js';
import { BackupTableDataRepository } from '../Repositories/BackupTableDataRepository.js';
import { TransactionControlRepository } from '../Repositories/TransactionControlRepository.js';
import { BackupPoolFactory } from './BackupPoolFactory.js';
import { BackupRowExporter } from './BackupRowExporter.js';
import { EPHEMERAL_TABLE_DATA } from './SchemaEvidence.js';
import { SchemaEvidenceReader } from './SchemaEvidenceReader.js';

import type { CoherentSnapshot } from './SchemaEvidence.js';

/**
 * Exports rows and stages chunk ciphertext from one REPEATABLE READ transaction while every
 * Files table is SHARE locked, so metadata and ciphertext describe the same instant.
 */
export class CoherentSnapshotService {
  constructor(
    private readonly pools = new BackupPoolFactory(),
    private readonly reader = new SchemaEvidenceReader(),
    private readonly exporter = new BackupRowExporter(),
    private readonly data = new BackupTableDataRepository(),
    private readonly inventory = new BackupInventoryRepository(),
    private readonly control = new TransactionControlRepository(),
  ) {}

  async create(databaseUrl:string, chunkRoot:string, chunkStageRoot:string, rowsPath:string):Promise<CoherentSnapshot> {
    const pool = this.pools.open(databaseUrl, 1); const client = await pool.connect();
    try {
      // Discover candidates outside the repeatable-read transaction. The
      // authoritative inventory is re-read only after all candidate tables are locked.
      const candidates = await this.reader.ownedTables(client);
      await this.data.beginRepeatableRead(client);
      await this.data.lockShared(client, candidates.tables);
      const owned = await this.reader.ownedTables(client);
      if (JSON.stringify(owned) !== JSON.stringify(candidates)) throw new Error('Files schema changed while backup locks were acquired');
      const snapshotId = await this.data.currentSnapshotId(client);
      const schema = await this.reader.evidence(client, owned);
      for (const table of schema.tables) if (table.name in EPHEMERAL_TABLE_DATA) table.rows = '0';
      if (await this.inventory.hasUnresolvedChunkReference(client)) throw new Error('Files metadata references a chunk absent from its inventory');
      const chunks = (await this.inventory.chunkInventory(client))
        .map(row => ({ ...row, backupPath: join(chunkStageRoot, row.collection_id, row.id.slice(0, 2), row.id) }));
      await this.exporter.writeRows(client, rowsPath, owned.tables);
      for (const chunk of chunks) {
        if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(chunk.collection_id) || !/^[a-f0-9]{64}$/.test(chunk.id) ||
            chunk.location !== `chunks/${ chunk.collection_id }/${ chunk.id }` || !Number.isSafeInteger(Number(chunk.stored_size))) {
          throw new Error('Chunk database inventory contains an unsafe or unsupported record');
        }
        await this.exporter.copyChunk(join(chunkRoot, chunk.collection_id, chunk.id.slice(0, 2), chunk.id), chunk.backupPath, Number(chunk.stored_size));
      }
      await this.control.commit(client); return { snapshotId, evidence: schema, chunks, rowsPath };
    } catch (error) { await this.control.rollback(client).catch(() => undefined); throw error } finally { client.release(); await pool.end() }
  }
}
