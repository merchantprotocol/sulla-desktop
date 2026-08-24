import { createHash, randomUUID } from 'crypto';
import { postgresClient } from '../database/PostgresClient';
import { ArtifactReceiptModel, type InsertArtifactReceiptInput } from '../database/models/ArtifactReceiptModel';

/**
 * Concise artifact receipts (#716).
 *
 * A "receipt" is the compact, deduplicated, redacted Projects comment that
 * records a task event (execution, review, repair, planning, external wait).
 * The full model output / tool trace / long-form narration is NEVER copied into
 * Projects — it stays on the dispatch, workflow-execution or conversation record
 * and is reached through the receipt's evidence link. Renders deterministically
 * so replaying an event never produces a second comment.
 */

/** Bump when the receipt shape or fingerprint basis changes. */
export const ARTIFACT_RECEIPT_SCHEMA_VERSION = 1;

/** Hard cap on rendered receipt comment length — keeps Projects readable. */
export const RECEIPT_COMMENT_MAX_CHARS = 1400;

/** Marker embedded in every receipt comment; a comment without it is legacy prose. */
export const RECEIPT_MARKER_PREFIX = '<!-- artifact-receipt';

export type ReceiptEventType =
  | 'execution' | 'review' | 'repair' | 'planning' | 'external_wait';

export type ReceiptEvidenceKind =
  | 'dispatch' | 'workflow_execution' | 'conversation' | 'custody' | 'wait' | 'other';

export interface ReceiptArtifact {
  type:          string;   // pull_request | issue | projects_task | document | ...
  canonicalRef?: string;   // owner/repo#123, a path, or a stable id
  url?:          string;   // https URL for drill-down
  hash?:         string;   // immutable SHA or content hash
  label?:        string;   // short human label
}

export interface ReceiptEvidence {
  kind: ReceiptEvidenceKind;
  ref:  string;            // id of the full record (NOT the transcript itself)
  url?: string;
}

export interface ArtifactReceiptInput {
  taskId:               string;
  eventType:            ReceiptEventType;
  actor?:               string;
  workflowExecutionId?: string;
  dispatchId?:          string;
  disposition?:         string;
  nextOwner?:           string;
  validationSummary?:   string;
  artifacts?:           ReceiptArtifact[];
  evidence?:            ReceiptEvidence;
}

export interface ArtifactReceipt {
  version:             number;
  taskId:              string;
  eventType:           ReceiptEventType;
  actor:               string | null;
  workflowExecutionId: string | null;
  dispatchId:          string | null;
  disposition:         string | null;
  nextOwner:           string | null;
  validationSummary:   string | null;
  artifacts:           ReceiptArtifact[];
  evidence:            ReceiptEvidence | null;
  fingerprint:         string;
}

export interface RecordReceiptResult {
  receipt:   ArtifactReceipt;
  deduped:   boolean;      // true when the same event had already been recorded
  commentId: string | null;
  receiptId: string;
}

const SECRET_PATTERNS: RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g,                // GitHub tokens
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,             // Slack tokens
  /sk-[A-Za-z0-9]{20,}/g,                       // OpenAI-style keys
  /AKIA[0-9A-Z]{16}/g,                          // AWS access key id
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** Strip credentials and obvious secret payloads from any text put in a comment. */
export function redactSecrets(text: string): string {
  let out = String(text ?? '');
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[REDACTED]');
  out = out.replace(
    /((?:authorization|bearer|token|password|secret|api[_-]?key)\s*["':=]{1,3}\s*)[A-Za-z0-9._\-]{8,}/gi,
    '$1[REDACTED]',
  );
  return out;
}

/** A comment is legacy prose if it carries no receipt marker (#716 migrates none). */
export function isLegacyComment(body: string | null | undefined): boolean {
  return !String(body ?? '').includes(RECEIPT_MARKER_PREFIX);
}

function stableArtifacts(artifacts: ReceiptArtifact[]): ReceiptArtifact[] {
  return [...artifacts]
    .map(a => ({
      type:         String(a.type ?? '').trim(),
      canonicalRef: a.canonicalRef ? String(a.canonicalRef).trim() : undefined,
      url:          a.url ? String(a.url).trim() : undefined,
      hash:         a.hash ? String(a.hash).trim() : undefined,
      label:        a.label ? String(a.label).trim() : undefined,
    }))
    .sort((x, y) =>
      `${ x.type }|${ x.canonicalRef ?? '' }|${ x.hash ?? '' }`
        .localeCompare(`${ y.type }|${ y.canonicalRef ?? '' }|${ y.hash ?? '' }`));
}

/** Deterministic dedupe key: identical events (ignoring actor/time) collide. */
export function computeReceiptFingerprint(input: ArtifactReceiptInput): string {
  const basis = {
    v:           ARTIFACT_RECEIPT_SCHEMA_VERSION,
    task:        input.taskId,
    event:       input.eventType,
    disposition: input.disposition ?? null,
    nextOwner:   input.nextOwner ?? null,
    artifacts:   stableArtifacts(input.artifacts ?? []),
    evidence:    input.evidence ? { kind: input.evidence.kind, ref: input.evidence.ref } : null,
  };
  return createHash('sha256').update(JSON.stringify(basis)).digest('hex');
}

export function buildReceipt(input: ArtifactReceiptInput): ArtifactReceipt {
  return {
    version:             ARTIFACT_RECEIPT_SCHEMA_VERSION,
    taskId:              input.taskId,
    eventType:           input.eventType,
    actor:               input.actor ?? null,
    workflowExecutionId: input.workflowExecutionId ?? null,
    dispatchId:          input.dispatchId ?? null,
    disposition:         input.disposition ?? null,
    nextOwner:           input.nextOwner ?? null,
    validationSummary:   input.validationSummary ?? null,
    artifacts:           stableArtifacts(input.artifacts ?? []),
    evidence:            input.evidence ?? null,
    fingerprint:         computeReceiptFingerprint(input),
  };
}

export function receiptInsertInput(receipt: ArtifactReceipt, id = randomUUID()): InsertArtifactReceiptInput {
  return {
    id,
    receiptVersion:      receipt.version,
    taskId:              receipt.taskId,
    eventType:           receipt.eventType,
    actor:               receipt.actor,
    workflowExecutionId: receipt.workflowExecutionId,
    dispatchId:          receipt.dispatchId,
    disposition:         receipt.disposition,
    nextOwner:           receipt.nextOwner,
    validationSummary:   receipt.validationSummary ? redactSecrets(receipt.validationSummary) : null,
    artifacts:           receipt.artifacts,
    contentHashes:       receipt.artifacts.map(a => a.hash).filter((h): h is string => Boolean(h)),
    evidenceKind:        receipt.evidence?.kind ?? null,
    evidenceRef:         receipt.evidence?.ref ?? null,
    evidenceUrl:         receipt.evidence?.url ?? null,
    fingerprint:         receipt.fingerprint,
  };
}

function truncate(text: string, max: number): string {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${ clean.slice(0, Math.max(0, max - 1)).trimEnd() }…`;
}

const EVENT_LABEL: Record<ReceiptEventType, string> = {
  execution: 'Execution', review: 'Review', repair: 'Repair',
  planning: 'Planning', external_wait: 'External wait',
};

/**
 * Render a short, redacted, size-bounded human comment from a receipt. Never
 * contains raw tool traces or secrets; full narration stays on the linked record.
 */
export function renderReceiptComment(receipt: ArtifactReceipt): string {
  const lines: string[] = [];
  lines.push(`**Artifact receipt · ${ EVENT_LABEL[receipt.eventType] ?? receipt.eventType }**` +
    (receipt.disposition ? ` — ${ redactSecrets(truncate(receipt.disposition, 40)) }` : ''));

  for (const a of receipt.artifacts.slice(0, 8)) {
    const ref = a.canonicalRef ? ` \`${ truncate(a.canonicalRef, 80) }\`` : '';
    const sha = a.hash ? ` (\`${ truncate(a.hash, 40) }\`)` : '';
    const url = a.url ? ` — ${ truncate(a.url, 200) }` : '';
    lines.push(`- ${ truncate(a.type || 'artifact', 40) }${ ref }${ sha }${ url }`);
  }
  if (receipt.artifacts.length > 8) lines.push(`- …and ${ receipt.artifacts.length - 8 } more`);

  if (receipt.validationSummary) lines.push(`Validation: ${ redactSecrets(truncate(receipt.validationSummary, 200)) }`);
  if (receipt.nextOwner)         lines.push(`Next: ${ truncate(receipt.nextOwner, 60) }`);
  if (receipt.evidence)          lines.push(`Evidence: ${ receipt.evidence.kind } \`${ truncate(receipt.evidence.ref, 80) }\`` +
    (receipt.evidence.url ? ` — ${ truncate(receipt.evidence.url, 200) }` : ''));

  const marker = `${ RECEIPT_MARKER_PREFIX } v="${ receipt.version }" fp="${ receipt.fingerprint }"` +
    (receipt.evidence ? ` evidence="${ receipt.evidence.kind }:${ truncate(receipt.evidence.ref, 80) }"` : '') + ` -->`;
  lines.push(marker);

  let body = redactSecrets(lines.join('\n'));
  if (body.length > RECEIPT_COMMENT_MAX_CHARS) {
    const head = body.slice(0, Math.max(0, RECEIPT_COMMENT_MAX_CHARS - marker.length - 40)).trimEnd();
    body = `${ head }\n… (truncated; full evidence linked)\n${ marker }`;
  }
  return body;
}

/**
 * Record one task event: persist a deduped receipt row and, only on first sight,
 * post one concise Projects comment linked to the full evidence record. Replaying
 * the same event adds no second comment. Full narration is never copied here.
 */
export async function recordReceipt(input: ArtifactReceiptInput): Promise<RecordReceiptResult> {
  const receipt = buildReceipt(input);
  const receiptId = randomUUID();
  const insert = receiptInsertInput(receipt, receiptId);

  return postgresClient.transaction(async(client) => {
    const { inserted, row } = await ArtifactReceiptModel.insertIfAbsentWithClient(client, insert);
    if (!inserted) {
      return { receipt, deduped: true, commentId: row?.comment_id ?? null, receiptId: row?.id ?? receiptId };
    }

    const commentId = `artifact-receipt-comment-${ randomUUID() }`;
    await client.query(`
      INSERT INTO work_task_comments (id, task_id, body, author)
      VALUES ($1, $2, $3, $4)
    `, [commentId, receipt.taskId, renderReceiptComment(receipt), receipt.actor ?? 'sulla']);
    await ArtifactReceiptModel.attachCommentWithClient(client, receiptId, commentId);
    return { receipt, deduped: false, commentId, receiptId };
  });
}
