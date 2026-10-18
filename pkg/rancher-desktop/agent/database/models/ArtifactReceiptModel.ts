import { getProjectsApplicationService } from '../../projects/application/ProjectsApplicationService';

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
  id:                   string;
  receiptVersion:       number;
  taskId:               string;
  eventType:            string;
  actor?:               string | null;
  workflowExecutionId?: string | null;
  dispatchId?:          string | null;
  disposition?:         string | null;
  nextOwner?:           string | null;
  validationSummary?:   string | null;
  artifacts:            unknown[];
  contentHashes:        string[];
  evidenceKind?:        string | null;
  evidenceRef?:         string | null;
  evidenceUrl?:         string | null;
  fingerprint:          string;
  generation?:          number | null;
}

export interface InsertArtifactReceiptResult {
  inserted: boolean;
  row:      ArtifactReceiptRow;
}

interface ArtifactEvidenceReference {
  receipt:            ArtifactReceiptRow;
  evidence:           unknown;
  evidenceReference?: { kind: unknown; ref: unknown; url: unknown };
}

/** Projects-owned receipt ledger reached only through the service boundary. */
export class ArtifactReceiptModel {
  static readonly TABLE = 'work_artifact_receipts';

  static insertIfAbsent(input: InsertArtifactReceiptInput): Promise<InsertArtifactReceiptResult> {
    return getProjectsApplicationService().insertArtifactReceipt(input, {
      actor:  input.actor?.trim() || 'sulla',
      source: 'system',
    });
  }

  /** Kept for source compatibility; transaction ownership now lives in Projects. */
  static insertIfAbsentWithClient(_client: unknown, input: InsertArtifactReceiptInput): Promise<InsertArtifactReceiptResult> {
    return this.insertIfAbsent(input);
  }

  static async attachComment(id: string, commentId: string): Promise<void> {
    await getProjectsApplicationService().attachArtifactReceiptComment(id, commentId);
  }

  /** Kept for source compatibility; transaction ownership now lives in Projects. */
  static attachCommentWithClient(_client: unknown, id: string, commentId: string): Promise<void> {
    return this.attachComment(id, commentId);
  }

  static listByTask(taskId: string): Promise<ArtifactReceiptRow[]> {
    return getProjectsApplicationService().listArtifactReceiptsByTask(taskId);
  }

  static async findByFingerprint(taskId: string, fingerprint: string): Promise<ArtifactReceiptRow | null> {
    return (await this.listByTask(taskId)).find(row => row.fingerprint === fingerprint) ?? null;
  }

  static findByHash(hash: string): Promise<ArtifactReceiptRow[]> {
    return getProjectsApplicationService().findArtifactReceiptsByHash(hash);
  }

  static findByComment(commentId: string): Promise<ArtifactReceiptRow | null> {
    return getProjectsApplicationService().findArtifactReceiptByComment(commentId);
  }

  static async loadEvidenceForComment(commentId: string): Promise<{ receipt: ArtifactReceiptRow; evidence: unknown } | null> {
    const value = await getProjectsApplicationService().loadArtifactEvidenceReference(commentId) as ArtifactEvidenceReference | null;
    if (!value) return null;
    return { receipt: value.receipt, evidence: value.evidence ?? value.evidenceReference ?? null };
  }
}
