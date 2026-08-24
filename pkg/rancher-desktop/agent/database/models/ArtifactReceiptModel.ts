import { postgresClient } from '../PostgresClient';

/** One persisted concise artifact receipt (#716). Full narration is NOT stored
 * here — only the compact receipt plus a link to the full evidence record on a
 * dispatch / workflow-execution / conversation store. */
export interface ArtifactReceiptRow {
  id:                    string;
  receipt_version:       number;
  task_id:               string;
  event_type:            string;
  actor:                 string | null;
  workflow_execution_id: string | null;
  dispatch_id:           string | null;
  disposition:           string | null;
  next_owner:            string | null;
  validation_summary:    string | null;
  artifacts:             unknown;
  content_hashes:        string[];
  evidence_kind:         string | null;
  evidence_ref:          string | null;
  evidence_url:          string | null;
  fingerprint:           string;
  comment_id:            string | null;
  created_at:            string;
}

export interface InsertArtifactReceiptInput {
  id:                    string;
  receiptVersion:        number;
  taskId:                string;
  eventType:             string;
  actor?:                string | null;
  workflowExecutionId?:  string | null;
  dispatchId?:           string | null;
  disposition?:          string | null;
  nextOwner?:            string | null;
  validationSummary?:    string | null;
  artifacts:             unknown[];
  contentHashes:         string[];
  evidenceKind?:         string | null;
  evidenceRef?:          string | null;
  evidenceUrl?:          string | null;
  fingerprint:           string;
}

export interface InsertArtifactReceiptResult {
  inserted: boolean;
  row:      ArtifactReceiptRow;
}

/**
 * Durable, restart-safe artifact-receipt ledger (#716). Exactly one row per
 * distinct task event, deduped on (task_id, fingerprint); immutable hashes and
 * canonical refs stay queryable for audit.
 */
export class ArtifactReceiptModel {
  static readonly TABLE = 'work_artifact_receipts';

  /** Insert a receipt, or return the existing row when the same event replays. */
  static async insertIfAbsent(input: InsertArtifactReceiptInput): Promise<InsertArtifactReceiptResult> {
    const inserted = await postgresClient.query<ArtifactReceiptRow>(
      `INSERT INTO ${ ArtifactReceiptModel.TABLE }
         (id, receipt_version, task_id, event_type, actor, workflow_execution_id,
          dispatch_id, disposition, next_owner, validation_summary, artifacts,
          content_hashes, evidence_kind, evidence_ref, evidence_url, fingerprint)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16)
       ON CONFLICT (task_id, fingerprint) DO NOTHING
       RETURNING *`,
      [
        input.id, input.receiptVersion, input.taskId, input.eventType,
        input.actor ?? null, input.workflowExecutionId ?? null, input.dispatchId ?? null,
        input.disposition ?? null, input.nextOwner ?? null, input.validationSummary ?? null,
        JSON.stringify(input.artifacts ?? []), input.contentHashes ?? [],
        input.evidenceKind ?? null, input.evidenceRef ?? null, input.evidenceUrl ?? null,
        input.fingerprint,
      ],
    );
    if (inserted.length > 0) return { inserted: true, row: inserted[0] };

    const existing = await postgresClient.query<ArtifactReceiptRow>(
      `SELECT * FROM ${ ArtifactReceiptModel.TABLE } WHERE task_id = $1 AND fingerprint = $2`,
      [input.taskId, input.fingerprint],
    );
    return { inserted: false, row: existing[0] };
  }

  static async attachComment(id: string, commentId: string): Promise<void> {
    await postgresClient.query(
      `UPDATE ${ ArtifactReceiptModel.TABLE } SET comment_id = $2 WHERE id = $1`,
      [id, commentId],
    );
  }

  static async listByTask(taskId: string): Promise<ArtifactReceiptRow[]> {
    return postgresClient.query<ArtifactReceiptRow>(
      `SELECT * FROM ${ ArtifactReceiptModel.TABLE } WHERE task_id = $1 ORDER BY created_at ASC`,
      [taskId],
    );
  }

  static async findByFingerprint(taskId: string, fingerprint: string): Promise<ArtifactReceiptRow | null> {
    const rows = await postgresClient.query<ArtifactReceiptRow>(
      `SELECT * FROM ${ ArtifactReceiptModel.TABLE } WHERE task_id = $1 AND fingerprint = $2`,
      [taskId, fingerprint],
    );
    return rows[0] ?? null;
  }

  /** Audit drill-down: receipts referencing a given immutable artifact hash. */
  static async findByHash(hash: string): Promise<ArtifactReceiptRow[]> {
    return postgresClient.query<ArtifactReceiptRow>(
      `SELECT * FROM ${ ArtifactReceiptModel.TABLE } WHERE $1 = ANY (content_hashes) ORDER BY created_at ASC`,
      [hash],
    );
  }
}
