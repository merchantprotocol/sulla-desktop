// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

/** Written by the backfill once every JSON embedding has a halfvec row and the HNSW index exists. */
export const VECTOR_READY_MARKER = '045_pgvector_backfill_complete';
const NEGATIVE_TTL_MS = 15_000;

interface Cached { value: boolean; checkedAt: number }

class Probe {
  private cached?: Cached;
  constructor(private readonly sql: string) {}
  async get(db: pg.Pool): Promise<boolean> {
    if (this.cached?.value || (this.cached && Date.now() - this.cached.checkedAt < NEGATIVE_TTL_MS)) return this.cached.value;
    const value = Boolean((await db.query(this.sql)).rows[0]?.ok);
    this.cached = { value, checkedAt: Date.now() };
    return value;
  }
}

const table = new Probe("SELECT to_regclass('file_search_vectors') IS NOT NULL ok");
const ready = new Probe(`SELECT to_regclass('file_search_vectors') IS NOT NULL
  AND EXISTS(SELECT 1 FROM files_schema_migrations WHERE version='${ VECTOR_READY_MARKER }') ok`);

/** The halfvec table exists, so new embeddings should also be written to it. */
export const vectorTableExists = (db: pg.Pool): Promise<boolean> => table.get(db);
/** The backfill finished: semantic search may read halfvec and JSON copies may be dropped. */
export const vectorSearchReady = (db: pg.Pool): Promise<boolean> => ready.get(db);
