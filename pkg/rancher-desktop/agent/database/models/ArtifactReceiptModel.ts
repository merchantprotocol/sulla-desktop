import { postgresClient } from '../PostgresClient';

import type { PoolClient } from 'pg';

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
  generation:            number | null;
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
  generation?:           number | null;
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
    return postgresClient.transaction(client => this.insertIfAbsentWithClient(client, input));
  }

  static async insertIfAbsentWithClient(
    client: PoolClient,
    input: InsertArtifactReceiptInput,
  ): Promise<InsertArtifactReceiptResult> {
    const inserted = await client.query<ArtifactReceiptRow>(
      `INSERT INTO ${ ArtifactReceiptModel.TABLE }
         (id, receipt_version, task_id, event_type, actor, workflow_execution_id,
          dispatch_id, disposition, next_owner, validation_summary, artifacts,
          content_hashes, evidence_kind, evidence_ref, evidence_url, fingerprint, generation)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (task_id, fingerprint) DO NOTHING
       RETURNING *`,
      [
        input.id, input.receiptVersion, input.taskId, input.eventType,
        input.actor ?? null, input.workflowExecutionId ?? null, input.dispatchId ?? null,
        input.disposition ?? null, input.nextOwner ?? null, input.validationSummary ?? null,
        JSON.stringify(input.artifacts ?? []), input.contentHashes ?? [],
        input.evidenceKind ?? null, input.evidenceRef ?? null, input.evidenceUrl ?? null,
        input.fingerprint, input.generation ?? null,
      ],
    );
    if (inserted.rows.length > 0) return { inserted: true, row: inserted.rows[0] };

    const existing = await client.query<ArtifactReceiptRow>(
      `SELECT * FROM ${ ArtifactReceiptModel.TABLE } WHERE task_id = $1 AND fingerprint = $2`,
      [input.taskId, input.fingerprint],
    );
    return { inserted: false, row: existing.rows[0] };
  }

  static async attachComment(id: string, commentId: string): Promise<void> {
    await postgresClient.query(
      `UPDATE ${ ArtifactReceiptModel.TABLE } SET comment_id = $2 WHERE id = $1`,
      [id, commentId],
    );
  }

  static async attachCommentWithClient(client: PoolClient, id: string, commentId: string): Promise<void> {
    await client.query(
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

  static async findByComment(commentId: string): Promise<ArtifactReceiptRow | null> {
    const rows = await postgresClient.query<ArtifactReceiptRow>(
      `SELECT * FROM ${ ArtifactReceiptModel.TABLE } WHERE comment_id = $1 LIMIT 1`,
      [commentId],
    );
    return rows[0] ?? null;
  }

  /** Authorized local drill-down. Evidence table selection is a closed enum. */
  static async loadEvidenceForComment(commentId: string): Promise<{ receipt: ArtifactReceiptRow; evidence: unknown } | null> {
    const receipt = await this.findByComment(commentId);
    if (!receipt) return null;
    let evidence: unknown = null;
    if (receipt.evidence_kind === 'dispatch' && receipt.evidence_ref) {
      evidence = await postgresClient.queryOne(
        `SELECT id, task_id, kind, status, attempt, agent_id, workflow_execution_id,
                result, error, origin_evidence, review_evidence, review_checks,
                review_findings, started_at, finished_at
           FROM work_task_dispatches WHERE id = $1`,
        [receipt.evidence_ref],
      );
    } else if (receipt.evidence_kind === 'workflow_execution' && receipt.evidence_ref) {
      evidence = await postgresClient.queryOne(
        `SELECT execution_id, workflow_id, workflow_name, status, trigger_input,
                error, started_at, completed_at
           FROM workflow_executions WHERE execution_id = $1`,
        [receipt.evidence_ref],
      );
    } else if (receipt.evidence_kind === 'custody') {
      evidence = await postgresClient.queryOne(
        `SELECT task_id, transition, custody, actor, created_at
           FROM work_task_artifact_custody WHERE task_id = $1
           ORDER BY created_at DESC LIMIT 1`,
        [receipt.task_id],
      );
    } else if (receipt.evidence_kind === 'wait' && receipt.evidence_ref) {
      evidence = await postgresClient.queryOne(
        `SELECT id, task_id, wait_kind, target_key, target, status,
                last_observed_fingerprint, last_error, check_count,
                created_at, updated_at, completed_at
           FROM work_task_waits WHERE id = $1`,
        [receipt.evidence_ref],
      );
    }
    return { receipt, evidence };
  }
}
