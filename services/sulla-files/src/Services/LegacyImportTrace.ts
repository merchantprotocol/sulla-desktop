// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomUUID } from 'node:crypto';

export type LegacyImportPhase =
  | 'completion-check'
  | 'staging-lock'
  | 'staging-master-verification'
  | 'staging-source-expansion'
  | 'staging-protection'
  | 'staging-collection-maps'
  | 'staging-file-maps'
  | 'staging-version-maps'
  | 'source-layout-scan'
  | 'native-layout-scan'
  | 'publish-lock'
  | 'publish-master-verification'
  | 'publish-identity-verification'
  | 'source-key-authentication'
  | 'shadow-key-authentication'
  | 'version-manifest-verification'
  | 'chunk-conversion'
  | 'manifest-publication'
  | 'file-publication'
  | 'version-publication'
  | 'version-lineage-publication'
  | 'version-provenance-verification'
  | 'current-version-publication'
  | 'access-publication'
  | 'graph-publication'
  | 'journal-publication'
  | 'audit-publication'
  | 'chunk-reference-publication'
  | 'publication-verification'
  | 'publication-commit';

/**
 * Decides which import failures may be logged by reason and which legacy failures
 * can be quarantined without locking healthy native Files data.
 */
export class LegacyImportFailurePolicy {
  static readonly safeMessages:ReadonlySet<string> = new Set([
    'Invalid Files import key material',
    'Invalid Files master key',
    'Invalid legacy collection key',
    'Legacy Files audit provenance mapping is incomplete',
    'Legacy Files base-version mapping is incomplete',
    'Legacy Files chunk collection has no authenticated metadata',
    'Legacy Files chunk conflict does not match converted content',
    'Legacy Files chunk has an invalid stored size',
    'Legacy Files chunk identity verification failed',
    'Legacy Files collection key authentication found ambiguous protected masters',
    'Legacy Files collection key authentication found no protected master',
    'Legacy Files collection mapping is incomplete',
    'Legacy Files converted manifest has no collection mapping',
    'Legacy Files converted manifest is missing',
    'Legacy Files current-version mapping is incomplete',
    'Legacy Files identity mapping is incomplete',
    'Legacy Files import rejected a non-directory path',
    'Legacy Files import rejected an unsafe source root',
    'Legacy Files import requires an absolute source root',
    'Legacy Files import verification is incomplete',
    'Legacy Files manifest conflict does not match converted content',
    'Legacy Files manifest has an invalid size',
    'Legacy Files manifest size verification failed',
    'Legacy Files manifested collection has ambiguous source layouts',
    'Legacy Files manifested collection has no exact source layout',
    'Legacy Files parent-version mapping is incomplete',
    'Legacy Files shadow collection key is unavailable',
    'Legacy Files source manifest authentication failed',
    'Legacy Files version conflict does not match source provenance',
    'Legacy Files version identity mapping is incomplete',
    'Legacy Files version manifest is missing',
    'Legacy Files version references a missing source collection',
    'Legacy Files version references an unmapped chunk collection',
    'Legacy Files version size verification failed',
    'Native shadow chunk verification failed',
    'Native source collection key is unavailable',
    'No legacy Files collections require import',
  ]);

  static readonly safeErrorCodes:ReadonlySet<string> = new Set([
    '08001', '08003', '08006', '23503', '23505', '23514', '40001', '40P01', '57P01',
    'EACCES', 'EEXIST', 'EISDIR', 'ELOOP', 'EMFILE', 'ENFILE', 'ENOENT', 'ENOSPC', 'ENOTDIR', 'EROFS',
  ]);

  static property(error:unknown, property:'name' | 'message' | 'code'):unknown {
    try { return typeof error === 'object' && error !== null ? Reflect.get(error, property) : undefined } catch { return undefined }
  }

  static quarantinable(error:unknown):boolean {
    const message = LegacyImportFailurePolicy.property(error, 'message');
    if (typeof message !== 'string') return false;
    if (message === 'Invalid Files import key material' || message === 'Invalid Files master key') return false;
    return LegacyImportFailurePolicy.safeMessages.has(message) ||
      /^Legacy Files (?:collection|bucket|chunk) does not exist$/.test(message) ||
      /^Legacy Files import found ambiguous (?:collection|bucket|chunk) identities$/.test(message) ||
      /^Legacy Files import rejected a linked or non-directory (?:collection|bucket)$/.test(message) ||
      /^Invalid legacy (?:collection|bucket|chunk) identity$/.test(message) ||
      /^Completed legacy Files import /.test(message);
  }
}

/** One import run's structured, secret-free diagnostics. */
export class LegacyImportTrace {
  readonly correlationId = randomUUID();
  private sequence = 0;
  phase:LegacyImportPhase = 'completion-check';

  mark(phase:LegacyImportPhase):void {
    this.phase = phase;
    this.write('legacy-import-stage');
  }

  completed():void { this.write('legacy-import-completed') }

  sourceKey(details:{ kind:'native' | 'legacy'; hasNativeKey:boolean; hasExternalChunks:boolean; hasNativeChunks:boolean }):void {
    this.write('legacy-import-source-key', details);
  }

  versionConflict(details: Record<string, boolean>): void {
    this.write('legacy-import-version-conflict', details);
  }

  failed(error:unknown):void {
    const name = LegacyImportFailurePolicy.property(error, 'name');
    const message = LegacyImportFailurePolicy.property(error, 'message');
    const code = LegacyImportFailurePolicy.property(error, 'code');
    this.write('legacy-import-failed', {
      errorName: name === 'Error' || name === 'TypeError' || name === 'RangeError' ? name : 'Error',
      ...(typeof message === 'string' && LegacyImportFailurePolicy.safeMessages.has(message) ? { reason: message } : {}),
      ...(typeof code === 'string' && LegacyImportFailurePolicy.safeErrorCodes.has(code) ? { reasonCode: code } : {}),
    });
  }

  private write(event:'legacy-import-stage' | 'legacy-import-source-key' | 'legacy-import-version-conflict' | 'legacy-import-completed' | 'legacy-import-failed', details:Record<string, unknown> = {}):void {
    try {
      const output = JSON.stringify({ source: 'sulla-files', event, correlationId: this.correlationId, sequence: ++this.sequence, phase: this.phase, ...details });
      if (event === 'legacy-import-failed') console.error(output); else console.info(output);
    } catch { /* Diagnostics must never affect import control flow. */ }
  }
}

export class LegacyImportContinuationRequiredError extends Error {}

/** A legacy item failed integrity/authentication checks and can be contained without locking healthy Files data. */
export class LegacyImportDataError extends Error {
  constructor(cause:unknown) {
    super('Legacy Files data was quarantined after import validation failed', { cause });
    this.name = 'LegacyImportDataError';
  }
}
