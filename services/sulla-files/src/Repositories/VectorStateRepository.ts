// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { SearchQueryable } from './IndexingJobRepository.js';

/** Written by the backfill once every JSON embedding has a halfvec row and the HNSW index exists. */
export const VECTOR_READY_MARKER = '045_pgvector_backfill_complete';

/** Reads whether pgvector storage exists and whether the halfvec backfill has finished. */
export class VectorStateRepository {
  constructor(private readonly db:SearchQueryable) {}

  /** The halfvec table exists (pgvector is installed). */
  async tableExists():Promise<boolean> {
    return Boolean((await this.db.query("SELECT to_regclass('file_search_vectors') IS NOT NULL ok")).rows[0]?.ok);
  }

  /** The table exists and the backfill wrote its ready marker. */
  async searchReady():Promise<boolean> {
    return Boolean((await this.db.query(`SELECT to_regclass('file_search_vectors') IS NOT NULL
  AND EXISTS(SELECT 1 FROM files_schema_migrations WHERE version='${ VECTOR_READY_MARKER }') ok`)).rows[0]?.ok);
  }
}
