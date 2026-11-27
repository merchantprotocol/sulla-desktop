// SPDX-License-Identifier: GPL-2.0-or-later
import { newerBuiltinAgentSlug } from '../../../shared/agentJobNames';

export interface PublishedAgentRow {
  id:                  string;
  source_kind:         string;
  removed_from_editor: boolean;
  use_case_file_id:    string | null;
  use_case_version_id: string | null;
}

interface PublicationReader { queryOne<T>(sql: string, params: unknown[]): Promise<T | null> }

/** Prove ownership and detect a split publication from the same database snapshot. */
export class RenamedAgentPublicationRepository {
  constructor(private readonly db: PublicationReader) {}

  async find(folder: string, rootIds: string[]) {
    const canonical = newerBuiltinAgentSlug(folder);
    if (!canonical || !rootIds.length) return null;
    return this.db.queryOne<PublishedAgentRow & { slug: string; split: boolean; folder_owns_root: boolean }>(
      `SELECT a.id,a.slug,a.source_kind,a.config @> '{"removedFromEditor":true}'::jsonb AS removed_from_editor,
              a.use_case_file_id,a.use_case_version_id,
              f.id IS NOT NULL AS folder_owns_root,
              COALESCE(f.use_case_file_id=$3 AND a.use_case_file_id <> $3, FALSE) AS split
         FROM agent_definitions a
         LEFT JOIN agent_definitions f ON f.slug=$4 AND f.use_case_file_id=ANY($2::uuid[])
         WHERE a.slug=$1 AND a.is_builtin AND a.use_case_file_id=ANY($2::uuid[])`,
      [canonical, rootIds, rootIds[0], folder]);
  }
}
