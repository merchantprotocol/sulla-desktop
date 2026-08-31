/**
 * ArtifactCustodyPolicy — optional, non-blocking evidence metadata for
 * Projects lifecycle transitions.
 *
 * Projects pipelines are not all software development, so no lifecycle
 * invariant may assume a coding-shaped evidence trail. Custody is a couple
 * of generic, OPTIONAL fields a caller may attach when a task enters review
 * or done: a coding pipeline might fill in branch/PR details, a non-coding
 * pipeline might record an artifact link and a note. Nothing is required
 * and no transition is ever blocked for missing or partial custody.
 *
 * When custody is supplied and well-formed enough to persist, it is written
 * as an immutable record in the same transaction as the task move, purely
 * for audit/history — never as a gate.
 */

export type CustodyWorkKind = 'code' | 'non_code';
export type CustodyTransition = 'in_review' | 'done';

export interface ArtifactCustody {
  workKind?:    CustodyWorkKind;
  branch?:      string | null;
  commitSha?:   string | null;
  prUrl?:       string | null;
  prHeadSha?:   string | null;
  validation?:  unknown;
  provenance?:  unknown;
  artifactId?:  string | null;
  artifactUrl?: string | null;
  evidence?:    unknown;
}

export class ArtifactCustodyPolicy {
  /**
   * Structural sanity check only — never a completeness requirement.
   * Absent custody is fine. Present custody just has to be a plain object
   * so downstream field access can't blow up on a malformed payload.
   */
  static validate(custody: ArtifactCustody | null | undefined): { ok: boolean; missing: string[] } {
    if (custody === null || custody === undefined) return { ok: true, missing: [] };
    if (typeof custody !== 'object' || Array.isArray(custody)) return { ok: false, missing: ['custody'] };
    return { ok: true, missing: [] };
  }

  /**
   * Best-effort derivation of a custody record from the looser evidence fields
   * older callers already populate. Purely descriptive — an explicit
   * `custody` object always wins, and returning null just means no evidence
   * metadata gets attached, not that anything is blocked.
   */
  static derive(source: Record<string, unknown> | null | undefined): ArtifactCustody | null {
    if (!source) return null;
    const explicit = source.custody as ArtifactCustody | undefined;
    if (explicit && (explicit.workKind === 'code' || explicit.workKind === 'non_code')) return explicit;

    const artifactType = String(source.artifactType ?? '').toLowerCase();
    const looksCode = artifactType.includes('code')
      || artifactType.includes('pull_request')
      || artifactType.includes('branch');
    if (looksCode) {
      return {
        workKind:   'code',
        prUrl:      (source.artifactUrl as string) ?? null,
        prHeadSha:  (source.artifactRef as string) ?? null,
        branch:     (source.artifactRef as string) ?? null,
        commitSha:  (source.contentHash as string) ?? null,
        validation: source.reviewEvidence ?? null,
        provenance: source.provenance ?? null,
      };
    }
    if (artifactType) {
      return {
        workKind:    'non_code',
        artifactId:  (source.artifactRef as string) ?? null,
        artifactUrl: (source.artifactUrl as string) ?? null,
        evidence:    source.reviewEvidence ?? source.contentHash ?? null,
        provenance:  source.provenance ?? null,
      };
    }
    return null;
  }

  /**
   * Never throws. Custody is optional metadata, not a gate — kept as a
   * method (rather than deleted from call sites) so existing callers don't
   * need to change; it simply no longer does anything blocking.
   */
  static async assertForTransition(
    _transition: CustodyTransition,
    _custody: ArtifactCustody | null | undefined,
  ): Promise<void> {
    // Intentionally a no-op: no pipeline is required to supply custody.
  }

  static async persistWithClient(
    client: import('pg').PoolClient,
    taskId: string,
    transition: CustodyTransition,
    custody: ArtifactCustody,
    actor: string,
  ): Promise<void> {
    const { randomUUID } = await import('node:crypto');
    // work_task_artifact_custody.work_kind is NOT NULL; default to the
    // generic bucket when a caller attaches custody without picking one.
    const workKind = custody.workKind ?? 'non_code';
    await client.query(`
      INSERT INTO work_task_artifact_custody
        (id, task_id, transition, work_kind, custody, created_by)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6)
    `, [`custody-${ randomUUID() }`, taskId, transition, workKind, JSON.stringify(custody), actor]);
  }
}
