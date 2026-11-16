// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { Queryable } from '../db.js';

/** The `files` column of an integration_definitions row: manifest file name -> YAML text (or `{ content }`). */
export type StoredIntegrationFiles = Record<string, string | { content?: string }>;

interface StoredDefinition { files: StoredIntegrationFiles }

/** Read-only lookup of the database-backed integration manifests shipped to this installation. */
export interface IntegrationDefinitionLookup {
  /** The stored `files` value for `slug`, exactly as the row holds it; undefined when no row exists. */
  findFilesBySlug(slug: string): Promise<StoredIntegrationFiles | undefined>;
}

export class PostgresIntegrationDefinitionRepository implements IntegrationDefinitionLookup {
  constructor(private readonly db: Queryable) {}

  async findFilesBySlug(slug: string): Promise<StoredIntegrationFiles | undefined> {
    const result = await this.db.query<StoredDefinition>('SELECT files FROM integration_definitions WHERE slug=$1 LIMIT 1', [slug]);
    return result.rows[0]?.files;
  }
}
