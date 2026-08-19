/**
 * SystemPromptSectionModel — the editable CORE of the agent system prompt.
 *
 * Each identity/system-prompt row (soul, user, environment, agents, heartbeat,
 * plus any custom sections the human adds) lives here as one row. This is
 * layer 2 of the three-layer resolution (see migration 0048):
 *
 *   1. agent-specific physical file  (~/sulla/agents/<id>/*.md)  — per-agent override
 *   2. DB row                        (this table)                — editable global core
 *   3. baked-in native fallback      (systemPromptSectionDefaults / factories)
 *
 * Seeding is write-only-if-absent and honors `is_customized`: a fresh app that
 * ships an improved baked default updates only rows the human never touched.
 *
 * DUAL-STORE NOTE: reads and writes ONLY Postgres — no Redis hash. Main-process
 * only (imports postgresClient); the renderer reaches it via the
 * `system-prompt:*` IPC handlers in main/sullaEvents.ts.
 */
import {
  BUILTIN_SECTION_IDS,
  getSystemPromptSectionDefault,
  SYSTEM_PROMPT_SECTION_DEFAULTS,
} from '@pkg/agent/prompts/systemPromptSectionDefaults';

import { postgresClient } from '../PostgresClient';

// ── Types ──────────────────────────────────────────────────────────────

export interface SystemPromptSectionRecord {
  id:              string;
  title:           string;
  content:         string;
  priority:        number;
  enabled:         boolean;
  cache_stability: string;
  is_builtin:      boolean;
  is_generated:    boolean;
  is_customized:   boolean;
  source:          string | null;
  created_at:      string;
  updated_at:      string | null;
}

export interface AddSectionInput {
  id:              string;
  title:           string;
  content?:        string;
  priority?:       number;
  enabled?:        boolean;
  cache_stability?: string;
  source?:         string;
}

export interface UpdateSectionInput {
  title?:          string;
  content?:        string;
  priority?:       number;
  enabled?:        boolean;
  cache_stability?: string;
}

// ── Model ──────────────────────────────────────────────────────────────

export class SystemPromptSectionModel {
  private static readonly TABLE = 'sulla_system_prompt_sections';

  // ──────────────────────────────────────────────
  // Table bootstrap (idempotent) — mirrors migration 0048
  // ──────────────────────────────────────────────

  static async ensureTable(): Promise<void> {
    try {
      await postgresClient.query(`
        CREATE TABLE IF NOT EXISTS ${ SystemPromptSectionModel.TABLE } (
          id              TEXT        PRIMARY KEY,
          title           TEXT        NOT NULL,
          content         TEXT        NOT NULL DEFAULT '',
          priority        INTEGER     NOT NULL DEFAULT 100,
          enabled         BOOLEAN     NOT NULL DEFAULT true,
          cache_stability TEXT        NOT NULL DEFAULT 'stable',
          is_builtin      BOOLEAN     NOT NULL DEFAULT false,
          is_generated    BOOLEAN     NOT NULL DEFAULT false,
          is_customized   BOOLEAN     NOT NULL DEFAULT false,
          source          TEXT,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at      TIMESTAMPTZ
        )
      `);
      await postgresClient.query(`
        CREATE INDEX IF NOT EXISTS idx_sulla_sps_enabled_priority
          ON ${ SystemPromptSectionModel.TABLE } (enabled, priority, id)
      `);
    } catch (err) {
      console.error('[SystemPromptSectionModel] Failed to ensure table:', err);
    }
  }

  // ──────────────────────────────────────────────
  // Seeding — write-only-if-absent, honors is_customized
  // ──────────────────────────────────────────────

  /**
   * Seed the canonical builtin rows from the baked native fallbacks. Idempotent:
   *   - A row that does not yet exist is inserted from its shipped default.
   *   - An existing row the human HAS edited (is_customized = true) is never
   *     touched — their edits win over upstream improvements.
   *   - An existing builtin row the human has NOT edited follows upstream: its
   *     content/title/priority are refreshed from the (possibly newer) default.
   * Custom user-added rows are never affected.
   */
  static async seedDefaults(): Promise<void> {
    await SystemPromptSectionModel.ensureTable();

    for (const def of SYSTEM_PROMPT_SECTION_DEFAULTS) {
      try {
        const content = await def.resolveContent();
        const existing = await SystemPromptSectionModel.getById(def.id);

        if (!existing) {
          await postgresClient.query(
            `INSERT INTO ${ SystemPromptSectionModel.TABLE }
               (id, title, content, priority, enabled, cache_stability,
                is_builtin, is_generated, is_customized, source)
             VALUES ($1, $2, $3, $4, $5, $6, true, $7, false, 'baked-default')
             ON CONFLICT (id) DO NOTHING`,
            [def.id, def.title, content, def.priority, def.enabledByDefault, def.cacheStability, def.isGenerated],
          );
          continue;
        }

        // Refresh untouched builtin rows from the (possibly updated) shipped
        // default; leave customized rows and the enabled flag alone.
        if (existing.is_builtin && !existing.is_customized) {
          await postgresClient.query(
            `UPDATE ${ SystemPromptSectionModel.TABLE }
               SET content = $2, title = $3, priority = $4,
                   is_generated = $5, cache_stability = $6, updated_at = now()
             WHERE id = $1 AND is_customized = false`,
            [def.id, content, def.title, def.priority, def.isGenerated, def.cacheStability],
          );
        }
      } catch (err) {
        console.error(`[SystemPromptSectionModel] seedDefaults failed for '${ def.id }':`, err);
      }
    }
  }

  // ──────────────────────────────────────────────
  // Reads
  // ──────────────────────────────────────────────

  /** All rows, compiled-order (priority asc, id tiebreak). */
  static async list(): Promise<SystemPromptSectionRecord[]> {
    return postgresClient.query<SystemPromptSectionRecord>(
      `SELECT * FROM ${ SystemPromptSectionModel.TABLE } ORDER BY priority ASC, id ASC`,
    );
  }

  /** Enabled rows only — what the builder layers into the compiled prompt. */
  static async listEnabled(): Promise<SystemPromptSectionRecord[]> {
    return postgresClient.query<SystemPromptSectionRecord>(
      `SELECT * FROM ${ SystemPromptSectionModel.TABLE }
       WHERE enabled = true ORDER BY priority ASC, id ASC`,
    );
  }

  static async getById(id: string): Promise<SystemPromptSectionRecord | null> {
    const rows = await postgresClient.query<SystemPromptSectionRecord>(
      `SELECT * FROM ${ SystemPromptSectionModel.TABLE } WHERE id = $1 LIMIT 1`,
      [id],
    );
    return rows[0] ?? null;
  }

  // ──────────────────────────────────────────────
  // Writes
  // ──────────────────────────────────────────────

  /** Add a NEW custom section (is_builtin = false, fully deletable). */
  static async addCustom(input: AddSectionInput): Promise<SystemPromptSectionRecord> {
    const rows = await postgresClient.query<SystemPromptSectionRecord>(
      `INSERT INTO ${ SystemPromptSectionModel.TABLE }
         (id, title, content, priority, enabled, cache_stability,
          is_builtin, is_generated, is_customized, source)
       VALUES ($1, $2, $3, $4, $5, $6, false, false, true, $7)
       RETURNING *`,
      [
        input.id,
        input.title,
        input.content ?? '',
        input.priority ?? 100,
        input.enabled ?? true,
        input.cache_stability ?? 'stable',
        input.source ?? 'user',
      ],
    );
    return rows[0];
  }

  /**
   * Update mutable fields. Any CONTENT edit flips is_customized = true so future
   * seedDefaults() runs never clobber the human's version.
   */
  static async update(id: string, changes: UpdateSectionInput): Promise<SystemPromptSectionRecord | null> {
    const setClauses: string[] = ['updated_at = now()'];
    const values: any[] = [];
    let idx = 1;

    const assign = (col: string, val: any) => {
      setClauses.push(`${ col } = $${ idx++ }`);
      values.push(val);
    };

    if (changes.title           !== undefined) assign('title', changes.title);
    if (changes.priority        !== undefined) assign('priority', changes.priority);
    if (changes.enabled         !== undefined) assign('enabled', changes.enabled);
    if (changes.cache_stability !== undefined) assign('cache_stability', changes.cache_stability);
    if (changes.content         !== undefined) {
      assign('content', changes.content);
      setClauses.push('is_customized = true');
    }

    if (setClauses.length === 1) return null; // nothing to update
    values.push(id);

    const rows = await postgresClient.query<SystemPromptSectionRecord>(
      `UPDATE ${ SystemPromptSectionModel.TABLE } SET ${ setClauses.join(', ') }
       WHERE id = $${ idx } RETURNING *`,
      values,
    );
    return rows[0] ?? null;
  }

  /** Toggle a section on/off without editing its content. */
  static async setEnabled(id: string, enabled: boolean): Promise<boolean> {
    const result = await postgresClient.queryWithResult(
      `UPDATE ${ SystemPromptSectionModel.TABLE } SET enabled = $2, updated_at = now()
       WHERE id = $1`,
      [id, enabled],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Restore a builtin row to its shipped default content and clear the
   * customized flag. No-op for custom rows (they have no baked default).
   */
  static async resetToDefault(id: string): Promise<SystemPromptSectionRecord | null> {
    const def = getSystemPromptSectionDefault(id);
    if (!def) return null; // not a builtin — nothing to reset to

    const content = await def.resolveContent();
    const rows = await postgresClient.query<SystemPromptSectionRecord>(
      `UPDATE ${ SystemPromptSectionModel.TABLE }
         SET content = $2, title = $3, priority = $4, is_generated = $5,
             cache_stability = $6, is_customized = false, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, content, def.title, def.priority, def.isGenerated, def.cacheStability],
    );
    return rows[0] ?? null;
  }

  /**
   * Delete a CUSTOM section. Builtin rows are protected — they can be disabled
   * or reset but never deleted (returns false without touching the row).
   */
  static async remove(id: string): Promise<boolean> {
    if (BUILTIN_SECTION_IDS.has(id)) return false;
    const result = await postgresClient.queryWithResult(
      `DELETE FROM ${ SystemPromptSectionModel.TABLE } WHERE id = $1 AND is_builtin = false`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
