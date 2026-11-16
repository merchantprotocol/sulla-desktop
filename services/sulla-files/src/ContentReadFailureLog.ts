// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { FileContentIntegrityError } from './fileStream.js';

export interface ContentReadFailure { route:string; fileId?:string; versionId?:string | null; shareId?:string }
type Sink = (line:string) => void;

/**
 * A failed read of user content is never silent: one structured line per failure with the
 * cause class and the file/version ids, so `docker logs sulla_files` explains every 500.
 * It never logs content, paths, keys or the raw error object (which may carry buffers).
 */
export class ContentReadFailureLog {
  constructor(private readonly sink:Sink = line => console.error(line)) {}

  /** True for failures the client sees as a 5xx that is not a routine retryable busy signal. */
  static isServerFailure(error:unknown):boolean {
    const failure = error as { status?:unknown; code?:unknown } | undefined;
    if (failure?.code === 'FILES_DB_RETRYABLE' || failure?.code === '23505' || failure?.code === '55000') return false;
    return typeof failure?.status !== 'number' || failure.status >= 500;
  }

  static causeClass(error:unknown):string {
    if (error instanceof FileContentIntegrityError) return error.integrityClass;
    const code = (error as { code?:unknown })?.code;
    if (code === 'ENOENT') return 'chunk_blob_missing';
    if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) return `chunk_store_${ code.toLowerCase() }`;
    const message = String((error as { message?:unknown })?.message ?? '');
    if (/identity mismatch/i.test(message)) return 'chunk_identity_mismatch';
    if (/size mismatch|shorter than declared|longer than declared|changed during read/i.test(message)) return 'chunk_size_mismatch';
    if (/decrypt|ciphertext|forged|incorrect key/i.test(message)) return 'chunk_decrypt_failed';
    if (/locked|not unlocked|keyring|master key/i.test(message)) return 'keys_unavailable';
    if (error instanceof SyntaxError) return 'chunk_envelope_invalid';
    return 'unclassified';
  }

  report(error:unknown, failure:ContentReadFailure):void {
    const chunkId = error instanceof FileContentIntegrityError ? error.chunkId : undefined;
    const message = String((error as { message?:unknown })?.message ?? error).slice(0, 300);
    this.sink(`[SullaFiles] content read failed ${ JSON.stringify({ cause: ContentReadFailureLog.causeClass(error), route: failure.route,
      fileId: failure.fileId ?? null, versionId: failure.versionId ?? null, ...(failure.shareId ? { shareId: failure.shareId } : {}), ...(chunkId ? { chunkId } : {}), error: message }) }`);
  }
}
