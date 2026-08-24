/**
 * ArtifactCustodyPolicy — fail-closed artifact-evidence custody for protected
 * routine finalization.
 *
 * Coding work must record branch, commit SHA, remote PR URL, PR head SHA,
 * validation evidence, and provenance. Non-code work must record an
 * authoritative artifact id/URL plus evidence and provenance. When the
 * automatedProjectManagementEnforceCustody setting is on, a task cannot cross
 * into in_review or done unless the required custody is present — the
 * transition throws and the caller's transaction rolls back (fail closed).
 *
 * Ships dark: enforcement defaults off so existing pipelines keep flowing;
 * the human enables it from the Automated Project Management settings area
 * once routine-side population is in place.
 */
import { SullaSettingsModel } from '../database/models/SullaSettingsModel';

export type CustodyWorkKind = 'code' | 'non_code';
export type CustodyTransition = 'in_review' | 'done';

export interface ArtifactCustody {
  workKind:     CustodyWorkKind;
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

export const CUSTODY_ENFORCEMENT_KEY = 'automatedProjectManagementEnforceCustody';

export class ArtifactCustodyError extends Error {
  readonly code = 'artifact_custody_missing';
  readonly transition: CustodyTransition;
  readonly missing: string[];

  constructor(transition: CustodyTransition, missing: string[]) {
    super(`Artifact custody incomplete for ${ transition } transition; missing: ${ missing.join(', ') || 'workKind' }`);
    this.name = 'ArtifactCustodyError';
    this.transition = transition;
    this.missing = missing;
  }
}

function present(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

export class ArtifactCustodyPolicy {
  static async isEnforced(): Promise<boolean> {
    // This is a lifecycle invariant, not an operator preference. Keep reading
    // the retired key for downgrade compatibility, but never permit it to
    // disable the gate.
    await SullaSettingsModel.get(CUSTODY_ENFORCEMENT_KEY, true);
    return true;
  }

  /** Pure fail-closed validation. Never touches settings. */
  static validate(custody: ArtifactCustody | null | undefined): { ok: boolean; missing: string[] } {
    if (!custody || (custody.workKind !== 'code' && custody.workKind !== 'non_code')) {
      return { ok: false, missing: ['workKind'] };
    }
    const missing: string[] = [];
    if (custody.workKind === 'code') {
      if (!present(custody.branch))     missing.push('branch');
      if (!present(custody.commitSha))  missing.push('commitSha');
      if (!present(custody.prUrl))      missing.push('prUrl');
      if (!present(custody.prHeadSha))  missing.push('prHeadSha');
      if (!present(custody.validation)) missing.push('validation');
      if (!present(custody.provenance)) missing.push('provenance');
    } else {
      if (!present(custody.artifactId) && !present(custody.artifactUrl)) missing.push('artifactId|artifactUrl');
      if (!present(custody.evidence))   missing.push('evidence');
      if (!present(custody.provenance)) missing.push('provenance');
    }
    return { ok: missing.length === 0, missing };
  }

  /**
   * Best-effort derivation of a custody record from the looser evidence fields
   * older callers already populate, so the gate can validate existing work
   * without a caller rewrite. An explicit `custody` object always wins.
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

  static async assertForTransition(
    transition: CustodyTransition,
    custody: ArtifactCustody | null | undefined,
  ): Promise<void> {
    if (!(await this.isEnforced())) return;
    const { ok, missing } = this.validate(custody);
    if (!ok) throw new ArtifactCustodyError(transition, missing);
  }

  static async persistWithClient(
    client: import('pg').PoolClient,
    taskId: string,
    transition: CustodyTransition,
    custody: ArtifactCustody,
    actor: string,
  ): Promise<void> {
    const { randomUUID } = await import('node:crypto');
    await client.query(`
      INSERT INTO work_task_artifact_custody
        (id, task_id, transition, work_kind, custody, created_by)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6)
    `, [`custody-${ randomUUID() }`, taskId, transition, custody.workKind, JSON.stringify(custody), actor]);
  }
}
