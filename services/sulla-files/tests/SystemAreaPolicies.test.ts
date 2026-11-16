// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Unit specs (no database) for the vocabularies that used to be module-level Sets:
// startup failure classification, native-source page policy and system-area indexing policy.
import { describe, expect, it } from 'vitest';
import { NativeSourcePager } from '../src/nativeSourcePaging.js';
import type { NativeSourceKeyset, NativeSourcePageRepository } from '../src/Repositories/NativeSourcePageRepository.js';
import { SystemAreaMirror } from '../src/Services/SystemAreaMirror.js';
import { FilesSafeDiagnosticError, FilesStartupFailureClassifier } from '../src/startupDiagnostics.js';

class RecordingPageRepository {
  readonly calls:NativeSourceKeyset[] = [];
  async page(keyset:NativeSourceKeyset) { this.calls.push(keyset); return [] }
}

describe('startup failure classification', () => {
  // risk: privacy — only allowlisted codes leave the process; messages and unknown codes never do.
  it('maps known causes to safe codes and everything else to the fallback', () => {
    expect(FilesStartupFailureClassifier.classify(Object.assign(new Error('secret path /Users/x'), { code: 'ENOSPC' })))
      .toEqual({ code: 'FILES_FILESYSTEM_OPERATION_FAILED', class: 'filesystem', reasonCode: 'ENOSPC' });
    expect(FilesStartupFailureClassifier.classify(new Error('boom', { cause: { code: '40P01' } })))
      .toEqual({ code: 'FILES_DATABASE_OPERATION_FAILED', class: 'database', reasonCode: '40P01' });
    expect(FilesStartupFailureClassifier.classify(Object.assign(new Error('x'), { code: 'SECRET_TOKEN_abc' }))).toEqual({ code: 'FILES_STARTUP_FAILED', class: 'startup' });
  });

  it('keeps only allowlisted fields of an explicit diagnostic', () => {
    const error = new FilesSafeDiagnosticError({ code: 'FILES_VAULT_AUTHORITY_HTTP_FAILED', class: 'vault-authority', operation: 'principal-read', httpStatus: 502,
      reasonCode: 'token=abc' } as never, Object.assign(new Error('x'), { code: 'ECONNRESET' }));
    expect(FilesStartupFailureClassifier.classify(error))
      .toEqual({ code: 'FILES_VAULT_AUTHORITY_HTTP_FAILED', class: 'vault-authority', operation: 'principal-read', httpStatus: 502, reasonCode: 'ECONNRESET' });
    expect(FilesStartupFailureClassifier.project({ code: 'FILES_MADE_UP', class: 'startup' })).toEqual({ code: 'FILES_STARTUP_FAILED', class: 'startup' });
  });
});

describe('native source page policy', () => {
  // risk: unbounded reads — a page is always 1..1000 rows and an unknown state filter is dropped.
  it('clamps the limit, drops unknown states and restarts on an invalid cursor', async() => {
    const repository = new RecordingPageRepository();
    const pager = new NativeSourcePager(repository as unknown as NativeSourcePageRepository);
    await pager.page({ limit: 50_000, state: 'revoked' });
    await pager.page({ limit: -5, state: 'DROP TABLE', after: Buffer.from('nope|short').toString('base64url') });
    expect(repository.calls).toEqual([
      { afterAt: null, afterHandle: null, state: 'revoked', limit: 1000 },
      { afterAt: null, afterHandle: null, state: null, limit: 1 },
    ]);
    const handle = 'h'.repeat(43);
    expect(NativeSourcePager.decodeCursor(Buffer.from(`2026-11-01T00:00:00.000000Z|${ handle }`).toString('base64url'))).toEqual(['2026-11-01T00:00:00.000000Z', handle]);
  });
});

describe('system area indexing policy', () => {
  // risk: audit privacy — the Logs area is never search-indexed, whatever the caller's header says.
  it('never indexes Logs and mirrors only the Sulla area', () => {
    expect(SystemAreaMirror.shouldSkipSearchIndex(undefined, 'logs')).toBe(true);
    expect(SystemAreaMirror.shouldSkipSearchIndex('false', 'logs')).toBe(true);
    expect(SystemAreaMirror.shouldSkipSearchIndex('true', null)).toBe(false);
    expect(SystemAreaMirror.isSystemArea('sulla')).toBe(true);
    expect(SystemAreaMirror.isSystemArea('logs')).toBe(false);
  });
});
