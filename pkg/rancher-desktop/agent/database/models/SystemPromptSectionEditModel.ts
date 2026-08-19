/**
 * SystemPromptSectionEditModel — staged, human-approved edits to the editable
 * system-prompt sections (see SystemPromptSectionModel / migration 0049).
 *
 * The guardrail: agents may only PROPOSE a change here. The proposed content is
 * inert until a human approves it in Language Model Settings → System Prompt, at
 * which point it is copied into the live sulla_system_prompt_sections row. The
 * prompt builder never reads this table, so a pending proposal can never affect
 * any agent's compiled prompt.
 *
 * Main-process only (imports postgresClient); the renderer reaches it via the
 * `system-prompt-edits:*` IPC handlers in main/sullaEvents.ts.
 */
import { postgresClient } from '../PostgresClient';

import { SystemPromptSectionModel, type SystemPromptSectionRecord } from './SystemPromptSectionModel';

// ── Types ──────────────────────────────────────────────────────────────

export type EditStatus = 'pending' | 'approved' | 'denied' | 'superseded';

export interface SectionEditRecord {
  id:               string;
  section_id:       string;
  proposed_content: string;
  base_content:     string;
  rationale:        string | null;
  status:           EditStatus;
  proposed_by:      string | null;
  reviewed_by:      string | null;
  created_at:       string;
  reviewed_at:      string | null;
}

export interface ProposeEditInput {
  section_id:       string;
  proposed_content: string;
  rationale?:       string;
  proposed_by?:     string;
}

// ── Tiny-ID generator (matches RulesModel/observations) ────────────────

function generateTinyId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = '';
  for (let i = 0; i < 6; i++) id += chars.charAt(Math.floor(Math.random() * chars.length));
  return id;
}

// ── Model ──────────────────────────────────────────────────────────────

export class SystemPromptSectionEditModel {
  private static readonly TABLE = 'sulla_system_prompt_section_edits';

  static async ensureTable(): Promise<void> {
    try {
      await postgresClient.query(`
        CREATE TABLE IF NOT EXISTS ${ SystemPromptSectionEditModel.TABLE } (
          id               TEXT        PRIMARY KEY,
          section_id       TEXT        NOT NULL,
          proposed_content TEXT        NOT NULL,
          base_content     TEXT        NOT NULL DEFAULT '',
          rationale        TEXT,
          status           TEXT        NOT NULL DEFAULT 'pending',
          proposed_by      TEXT,
          reviewed_by      TEXT,
          created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
          reviewed_at      TIMESTAMPTZ
        )
      `);
      await postgresClient.query(`
        CREATE INDEX IF NOT EXISTS idx_sulla_sps_edits_pending
          ON ${ SystemPromptSectionEditModel.TABLE } (status, section_id, created_at DESC)
      `);
    } catch (err) {
      console.error('[SystemPromptSectionEditModel] Failed to ensure table:', err);
    }
  }

  // ──────────────────────────────────────────────
  // Propose — the ONLY write agents are allowed
  // ──────────────────────────────────────────────

  /**
   * Stage a proposed edit for a section. Snapshots the section's current content
   * as base_content so the diff stays accurate even if the live row drifts. Only
   * valid for an existing section id — returns null otherwise.
   */
  static async propose(input: ProposeEditInput): Promise<SectionEditRecord | null> {
    const section = await SystemPromptSectionModel.getById(input.section_id);
    if (!section) return null;

    const rows = await postgresClient.query<SectionEditRecord>(
      `INSERT INTO ${ SystemPromptSectionEditModel.TABLE }
         (id, section_id, proposed_content, base_content, rationale, status, proposed_by)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6)
       RETURNING *`,
      [
        generateTinyId(),
        input.section_id,
        input.proposed_content,
        section.content,
        input.rationale ?? null,
        input.proposed_by ?? null,
      ],
    );
    return rows[0] ?? null;
  }

  // ──────────────────────────────────────────────
  // Reads
  // ──────────────────────────────────────────────

  static async listPending(): Promise<SectionEditRecord[]> {
    return postgresClient.query<SectionEditRecord>(
      `SELECT * FROM ${ SystemPromptSectionEditModel.TABLE }
       WHERE status = 'pending' ORDER BY created_at ASC`,
    );
  }

  static async getById(id: string): Promise<SectionEditRecord | null> {
    const rows = await postgresClient.query<SectionEditRecord>(
      `SELECT * FROM ${ SystemPromptSectionEditModel.TABLE } WHERE id = $1 LIMIT 1`,
      [id],
    );
    return rows[0] ?? null;
  }

  /** History for one section (any status), newest first. */
  static async listBySection(sectionId: string, limit = 50): Promise<SectionEditRecord[]> {
    return postgresClient.query<SectionEditRecord>(
      `SELECT * FROM ${ SystemPromptSectionEditModel.TABLE }
       WHERE section_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [sectionId, limit],
    );
  }

  // ──────────────────────────────────────────────
  // Review actions
  // ──────────────────────────────────────────────

  /**
   * Approve a pending proposal: copy its content (or the human's amended version
   * via `finalContent` — "edit & approve") into the live section row, mark the
   * proposal approved, and supersede any other pending proposals for the same
   * section. Returns the updated section row + the approved edit, or null.
   */
  static async approve(
    id: string,
    opts: { finalContent?: string; reviewed_by?: string } = {},
  ): Promise<{ section: SystemPromptSectionRecord | null; edit: SectionEditRecord } | null> {
    const edit = await SystemPromptSectionEditModel.getById(id);
    if (!edit || edit.status !== 'pending') return null;

    const content = opts.finalContent ?? edit.proposed_content;

    // Apply to the live row (flips is_customized in SystemPromptSectionModel.update).
    const section = await SystemPromptSectionModel.update(edit.section_id, { content });

    const rows = await postgresClient.query<SectionEditRecord>(
      `UPDATE ${ SystemPromptSectionEditModel.TABLE }
         SET status = 'approved', reviewed_by = $2, reviewed_at = now(),
             proposed_content = $3
       WHERE id = $1 RETURNING *`,
      [id, opts.reviewed_by ?? 'human', content],
    );

    // Retire any other still-pending proposals for the same section.
    await postgresClient.query(
      `UPDATE ${ SystemPromptSectionEditModel.TABLE }
         SET status = 'superseded', reviewed_at = now()
       WHERE section_id = $1 AND status = 'pending' AND id <> $2`,
      [edit.section_id, id],
    );

    return { section, edit: rows[0] ?? edit };
  }

  /** Deny a pending proposal without touching the live row. */
  static async deny(id: string, opts: { reviewed_by?: string } = {}): Promise<SectionEditRecord | null> {
    const rows = await postgresClient.query<SectionEditRecord>(
      `UPDATE ${ SystemPromptSectionEditModel.TABLE }
         SET status = 'denied', reviewed_by = $2, reviewed_at = now()
       WHERE id = $1 AND status = 'pending' RETURNING *`,
      [id, opts.reviewed_by ?? 'human'],
    );
    return rows[0] ?? null;
  }
}
