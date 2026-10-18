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
  | 'cleanup'
  | 'server-keyring'
  | 'server-initialization';

export type FilesDiagnosticClass =
  | 'bootstrap'
  | 'database'
  | 'filesystem'
  | 'master-key'
  | 'startup'
  | 'transport'
  | 'vault-authority';

export type VaultAuthorityOperation =
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

const STARTUP_STAGES = new Set<FilesStartupStage>([
  'bootstrap-state', 'preflight', 'legacy-import', 'legacy-import-verification', 'keyring', 'recovery',
  'identity-adoption', 'manager-initialization', 'recovery-enrollment', 'residency-recovery', 'indexer',
  'enrichment', 'cleanup', 'server-keyring', 'server-initialization',
]);
const DIAGNOSTIC_CLASSES = new Set<FilesDiagnosticClass>([
  'bootstrap', 'database', 'filesystem', 'master-key', 'startup', 'transport', 'vault-authority',
]);
const VAULT_OPERATIONS = new Set<VaultAuthorityOperation>([
  'principal-read', 'custody-recipient', 'bundle-registration', 'device-recovery',
]);
const BOOTSTRAP_CODES = new Set([
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
const DIAGNOSTIC_CODES = new Set([
  ...BOOTSTRAP_CODES,
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
const DATABASE_CODES = new Set(['08001', '08003', '08006', '23503', '23505', '23514', '40001', '40P01', '57P01']);
const FILESYSTEM_CODES = new Set(['EACCES', 'EEXIST', 'EISDIR', 'ELOOP', 'EMFILE', 'ENFILE', 'ENOENT', 'ENOSPC', 'ENOTDIR', 'EROFS']);
const TRANSPORT_CODES = new Set(['ABORT_ERR', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'ETIMEDOUT']);
const REASON_CODES = new Set([...DATABASE_CODES, ...FILESYSTEM_CODES, ...TRANSPORT_CODES]);
const FALLBACK:SafeDiagnosticDetails = Object.freeze({ code: 'FILES_STARTUP_FAILED', class: 'startup' });

/** Carries only explicitly allowlisted metadata through otherwise opaque failures. */
export class FilesSafeDiagnosticError extends Error {
  constructor(
    readonly diagnostic:SafeDiagnosticDetails,
    cause?:unknown,
  ) {
    super('Files operation failed', { cause });
  }
}

function safeProperty(value:unknown, property:'diagnostic' | 'cause' | 'code' | 'class' | 'operation' | 'httpStatus' | 'reasonCode'):unknown {
  try {
    return typeof value === 'object' && value !== null ? Reflect.get(value, property) : undefined;
  } catch {
    return undefined;
  }
}

function safeInstanceOf(value:unknown, constructor:Function):boolean {
  try { return value instanceof constructor } catch { return false }
}

function safeReasonCode(value:unknown):string | undefined {
  const code = safeProperty(value, 'code');
  return typeof code === 'string' && REASON_CODES.has(code) ? code : undefined;
}

function projectDiagnostic(value:unknown):SafeDiagnosticDetails {
  const code = safeProperty(value, 'code');
  const diagnosticClass = safeProperty(value, 'class');
  if (typeof code !== 'string' || !DIAGNOSTIC_CODES.has(code) ||
      typeof diagnosticClass !== 'string' || !DIAGNOSTIC_CLASSES.has(diagnosticClass as FilesDiagnosticClass)) return FALLBACK;
  const operation = safeProperty(value, 'operation');
  const httpStatus = safeProperty(value, 'httpStatus');
  const reasonCode = safeProperty(value, 'reasonCode');
  return {
    code,
    class: diagnosticClass as FilesDiagnosticClass,
    ...(typeof operation === 'string' && VAULT_OPERATIONS.has(operation as VaultAuthorityOperation)
      ? { operation: operation as VaultAuthorityOperation }
      : {}),
    ...(typeof httpStatus === 'number' && Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599
      ? { httpStatus }
      : {}),
    ...(typeof reasonCode === 'string' && REASON_CODES.has(reasonCode) ? { reasonCode } : {}),
  };
}

function nestedReason(error:unknown):string | undefined {
  const visited = new Set<unknown>();
  let current:unknown = safeProperty(error, 'cause');
  for (let depth = 0; current !== undefined && depth < 3 && !visited.has(current); depth++) {
    visited.add(current);
    const reasonCode = safeReasonCode(current);
    if (reasonCode) return reasonCode;
    current = safeProperty(current, 'cause');
  }
  return undefined;
}

export function safeStartupFailure(error:unknown):SafeDiagnosticDetails {
  try {
    const visited = new Set<unknown>();
    let current:unknown = error;
    for (let depth = 0; current !== undefined && depth < 4 && !visited.has(current); depth++) {
      visited.add(current);
      if (safeInstanceOf(current, FilesSafeDiagnosticError)) {
        const projected = projectDiagnostic(safeProperty(current, 'diagnostic'));
        const reasonCode = projected.reasonCode ?? nestedReason(current);
        return reasonCode ? { ...projected, reasonCode } : projected;
      }
      if (safeInstanceOf(current, FilesMasterKeyRejectedError)) {
        return { code: 'FILES_MASTER_KEY_REJECTED', class: 'master-key' };
      }
      if (safeInstanceOf(current, FilesBootstrapError)) {
        const code = safeProperty(current, 'code');
        if (typeof code === 'string' && BOOTSTRAP_CODES.has(code)) return { code, class: 'bootstrap' };
      }
      const reasonCode = safeReasonCode(current);
      if (reasonCode && DATABASE_CODES.has(reasonCode)) return { code: 'FILES_DATABASE_OPERATION_FAILED', class: 'database', reasonCode };
      if (reasonCode && FILESYSTEM_CODES.has(reasonCode)) return { code: 'FILES_FILESYSTEM_OPERATION_FAILED', class: 'filesystem', reasonCode };
      if (reasonCode && TRANSPORT_CODES.has(reasonCode)) return { code: 'FILES_TRANSPORT_OPERATION_FAILED', class: 'transport', reasonCode };
      current = safeProperty(current, 'cause');
    }
  } catch {
    // Diagnostics must never affect startup control flow or key cleanup.
  }
  return FALLBACK;
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
      const safeStage = STARTUP_STAGES.has(stage) ? stage : 'bootstrap-state';
      const safeFailure = failure ? projectDiagnostic(failure) : undefined;
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
