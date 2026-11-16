// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomUUID } from 'node:crypto';

import { FilesBootstrapError } from './bootstrapAuthority.js';
import { FilesMasterKeyRejectedError } from './keyring.js';

export type FilesStartupStage =
  | 'bootstrap-state'
  | 'preflight'
  | 'legacy-import'
  | 'legacy-import-verification'
  | 'keyring'
  | 'recovery'
  | 'identity-adoption'
  | 'manager-initialization'
  | 'recovery-enrollment'
  | 'residency-recovery'
  | 'indexer'
  | 'enrichment'
  | 'cleanup';

export type FilesDiagnosticClass =
  | 'bootstrap'
  | 'database'
  | 'filesystem'
  | 'master-key'
  | 'startup'
  | 'transport'
  | 'vault-authority';

export type VaultAuthorityOperation =
  | 'backup-credentials'
  | 'principal-read'
  | 'custody-recipient'
  | 'bundle-registration'
  | 'device-recovery';

interface SafeDiagnosticDetails {
  code:string;
  class:FilesDiagnosticClass;
  operation?:VaultAuthorityOperation;
  httpStatus?:number;
  reasonCode?:string;
}

/** Carries only explicitly allowlisted metadata through otherwise opaque failures. */
export class FilesSafeDiagnosticError extends Error {
  constructor(
    readonly diagnostic:SafeDiagnosticDetails,
    cause?:unknown,
  ) {
    super('Files operation failed', { cause });
  }
}

/**
 * Projects any startup failure onto the fixed diagnostic vocabulary below. Only allowlisted codes,
 * classes, operations and statuses ever leave; everything else becomes FILES_STARTUP_FAILED.
 */
export class FilesStartupFailureClassifier {
  static readonly stages:ReadonlySet<FilesStartupStage> = new Set<FilesStartupStage>([
    'bootstrap-state', 'preflight', 'legacy-import', 'legacy-import-verification', 'keyring', 'recovery',
    'identity-adoption', 'manager-initialization', 'recovery-enrollment', 'residency-recovery', 'indexer',
    'enrichment', 'cleanup',
  ]);
  private static readonly diagnosticClasses:ReadonlySet<FilesDiagnosticClass> = new Set<FilesDiagnosticClass>([
    'bootstrap', 'database', 'filesystem', 'master-key', 'startup', 'transport', 'vault-authority',
  ]);
  private static readonly vaultOperations:ReadonlySet<VaultAuthorityOperation> = new Set<VaultAuthorityOperation>([
    'backup-credentials', 'principal-read', 'custody-recipient', 'bundle-registration', 'device-recovery',
  ]);
  private static readonly bootstrapCodes:ReadonlySet<string> = new Set([
    'FILES_BOOTSTRAP_CANCELLED',
    'FILES_BOOTSTRAP_STATE_CHANGED',
    'FILES_LEGACY_IMPORT_INCOMPLETE',
    'FILES_LEGACY_IMPORT_QUARANTINED',
    'FILES_LEGACY_KEY_REQUIRED',
    'FILES_MASTER_BLOB_REQUIRED',
    'FILES_MASTER_KEY_REJECTED',
    'FILES_MASTER_STATE_INCOMPLETE',
    'FILES_RECOVERY_UNAVAILABLE',
  ]);
  private static readonly diagnosticCodes:ReadonlySet<string> = new Set([
    ...FilesStartupFailureClassifier.bootstrapCodes,
    'FILES_DATABASE_OPERATION_FAILED',
    'FILES_FILESYSTEM_OPERATION_FAILED',
    'FILES_STARTUP_FAILED',
    'FILES_TRANSPORT_OPERATION_FAILED',
    'FILES_VAULT_AUTHORITY_CA_UNAVAILABLE',
    'FILES_VAULT_AUTHORITY_HTTP_FAILED',
    'FILES_VAULT_AUTHORITY_REQUEST_ABORTED',
    'FILES_VAULT_AUTHORITY_REQUEST_FAILED',
    'FILES_VAULT_AUTHORITY_RESPONSE_FAILED',
    'FILES_VAULT_AUTHORITY_RESPONSE_INVALID',
    'FILES_VAULT_AUTHORITY_RESPONSE_TOO_LARGE',
  ]);
  private static readonly databaseCodes:ReadonlySet<string> = new Set(['08001', '08003', '08006', '23503', '23505', '23514', '40001', '40P01', '57P01']);
  private static readonly filesystemCodes:ReadonlySet<string> = new Set(['EACCES', 'EEXIST', 'EISDIR', 'ELOOP', 'EMFILE', 'ENFILE', 'ENOENT', 'ENOSPC', 'ENOTDIR', 'EROFS']);
  private static readonly transportCodes:ReadonlySet<string> = new Set(['ABORT_ERR', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'ETIMEDOUT']);
  private static readonly reasonCodes:ReadonlySet<string> = new Set([
    ...FilesStartupFailureClassifier.databaseCodes, ...FilesStartupFailureClassifier.filesystemCodes, ...FilesStartupFailureClassifier.transportCodes,
  ]);
  static readonly fallback:SafeDiagnosticDetails = Object.freeze({ code: 'FILES_STARTUP_FAILED', class: 'startup' });

  private static safeProperty(value:unknown, property:'diagnostic' | 'cause' | 'code' | 'class' | 'operation' | 'httpStatus' | 'reasonCode'):unknown {
    try {
      return typeof value === 'object' && value !== null ? Reflect.get(value, property) : undefined;
    } catch {
      return undefined;
    }
  }

  private static safeInstanceOf(value:unknown, constructor:Function):boolean {
    try { return value instanceof constructor } catch { return false }
  }

  private static safeReasonCode(value:unknown):string | undefined {
    const code = FilesStartupFailureClassifier.safeProperty(value, 'code');
    return typeof code === 'string' && FilesStartupFailureClassifier.reasonCodes.has(code) ? code : undefined;
  }

  /** Keeps only the allowlisted fields of a diagnostic; anything unrecognised becomes the fallback. */
  static project(value:unknown):SafeDiagnosticDetails {
    const C = FilesStartupFailureClassifier;
    const code = C.safeProperty(value, 'code');
    const diagnosticClass = C.safeProperty(value, 'class');
    if (typeof code !== 'string' || !C.diagnosticCodes.has(code) ||
        typeof diagnosticClass !== 'string' || !C.diagnosticClasses.has(diagnosticClass as FilesDiagnosticClass)) return C.fallback;
    const operation = C.safeProperty(value, 'operation');
    const httpStatus = C.safeProperty(value, 'httpStatus');
    const reasonCode = C.safeProperty(value, 'reasonCode');
    return {
      code,
      class: diagnosticClass as FilesDiagnosticClass,
      ...(typeof operation === 'string' && C.vaultOperations.has(operation as VaultAuthorityOperation)
        ? { operation: operation as VaultAuthorityOperation }
        : {}),
      ...(typeof httpStatus === 'number' && Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599
        ? { httpStatus }
        : {}),
      ...(typeof reasonCode === 'string' && C.reasonCodes.has(reasonCode) ? { reasonCode } : {}),
    };
  }

  private static nestedReason(error:unknown):string | undefined {
    const visited = new Set<unknown>();
    let current:unknown = FilesStartupFailureClassifier.safeProperty(error, 'cause');
    for (let depth = 0; current !== undefined && depth < 3 && !visited.has(current); depth++) {
      visited.add(current);
      const reasonCode = FilesStartupFailureClassifier.safeReasonCode(current);
      if (reasonCode) return reasonCode;
      current = FilesStartupFailureClassifier.safeProperty(current, 'cause');
    }
    return undefined;
  }

  static classify(error:unknown):SafeDiagnosticDetails {
    const C = FilesStartupFailureClassifier;
    try {
      const visited = new Set<unknown>();
      let current:unknown = error;
      for (let depth = 0; current !== undefined && depth < 4 && !visited.has(current); depth++) {
        visited.add(current);
        if (C.safeInstanceOf(current, FilesSafeDiagnosticError)) {
          const projected = C.project(C.safeProperty(current, 'diagnostic'));
          const reasonCode = projected.reasonCode ?? C.nestedReason(current);
          return reasonCode ? { ...projected, reasonCode } : projected;
        }
        if (C.safeInstanceOf(current, FilesMasterKeyRejectedError)) {
          return { code: 'FILES_MASTER_KEY_REJECTED', class: 'master-key' };
        }
        if (C.safeInstanceOf(current, FilesBootstrapError)) {
          const code = C.safeProperty(current, 'code');
          if (typeof code === 'string' && C.bootstrapCodes.has(code)) return { code, class: 'bootstrap' };
        }
        const reasonCode = C.safeReasonCode(current);
        if (reasonCode && C.databaseCodes.has(reasonCode)) return { code: 'FILES_DATABASE_OPERATION_FAILED', class: 'database', reasonCode };
        if (reasonCode && C.filesystemCodes.has(reasonCode)) return { code: 'FILES_FILESYSTEM_OPERATION_FAILED', class: 'filesystem', reasonCode };
        if (reasonCode && C.transportCodes.has(reasonCode)) return { code: 'FILES_TRANSPORT_OPERATION_FAILED', class: 'transport', reasonCode };
        current = C.safeProperty(current, 'cause');
      }
    } catch {
      // Diagnostics must never affect startup control flow or key cleanup.
    }
    return C.fallback;
  }
}

export function safeStartupFailure(error:unknown):SafeDiagnosticDetails {
  return FilesStartupFailureClassifier.classify(error);
}

function correlationId():string {
  try { return randomUUID() } catch { return 'unavailable' }
}

export class FilesStartupDiagnostics {
  readonly correlationId = correlationId();

  stage(stage:FilesStartupStage):void {
    this.write('stage', stage);
  }

  failed(stage:FilesStartupStage, error:unknown):SafeDiagnosticDetails {
    const failure = safeStartupFailure(error);
    this.write('failed', stage, failure);
    return failure;
  }

  degraded(stage:FilesStartupStage):void {
    this.write('degraded', stage, { code: 'FILES_LEGACY_IMPORT_QUARANTINED', class: 'startup' });
  }

  cleanupFailed(error:unknown):void {
    this.write('cleanup-failed', 'cleanup', safeStartupFailure(error));
  }

  completed(stage:FilesStartupStage):void {
    this.write('completed', stage);
  }

  private write(event:'stage' | 'failed' | 'degraded' | 'cleanup-failed' | 'completed', stage:FilesStartupStage, failure?:SafeDiagnosticDetails):void {
    try {
      const safeStage = FilesStartupFailureClassifier.stages.has(stage) ? stage : 'bootstrap-state';
      const safeFailure = failure ? FilesStartupFailureClassifier.project(failure) : undefined;
      const output = JSON.stringify({
        source: 'sulla-files',
        event:  `startup-${ event }`,
        correlationId: this.correlationId,
        stage: safeStage,
        ...(safeFailure ?? {}),
      });
      if (event === 'failed' || event === 'cleanup-failed') console.error(output);
      else if (event === 'degraded') console.warn(output);
      else console.info(output);
    } catch {
      // Logging is best-effort and must never mask the original failure.
    }
  }
}
