// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { NativeSourcePageRepository, type NativeSourceQueryable } from './Repositories/NativeSourcePageRepository.js';

/**
 * Keyset-paginated native source inventory (ORDER BY created_at, source_handle
 * LIMIT n, backed by files_native_sources_created). It replaces an unbounded
 * full-table sort that Desktop polled every 250 ms.
 */
export const NATIVE_SOURCE_PAGE_MAX = 1_000;

export interface NativeSourcePage { limit?:number; after?:string; state?:string }
export interface NativeSourcePageRow {
  fileId:         string;
  versionId:      string;
  collectionId:   string;
  path:           string;
  handle:         string;
  name:           string;
  sourceRevision: string;
  sourceHash:     string;
  state:          string;
  lastError?:     string;
  recovery:       Record<string, unknown>;
  /** Opaque cursor to pass as `after` to continue after this row. */
  cursor:         string;
}

export const NATIVE_SOURCE_PAGE_SQL = NativeSourcePageRepository.pageSql;

/** Reads native source pages; a page is clamped to 1..NATIVE_SOURCE_PAGE_MAX rows and an unknown state filter is ignored. */
export class NativeSourcePager {
  private static readonly states:ReadonlySet<string> = new Set(['active', 'conflict', 'reselect-required', 'revoked']);

  constructor(private readonly repository:NativeSourcePageRepository) {}

  /** Opaque keyset cursor: base64url("<ISO created_at>|<source handle>"). Invalid cursors start from the beginning. */
  static decodeCursor(cursor:string | undefined):[string | null, string | null] {
    if (!cursor) return [null, null];
    const [at, handle] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (!at || Number.isNaN(Date.parse(at)) || !/^[A-Za-z0-9_-]{43}$/.test(handle ?? '')) return [null, null];
    return [at, handle];
  }

  async page(page:NativeSourcePage = {}):Promise<NativeSourcePageRow[]> {
    const limit = Math.max(1, Math.min(NATIVE_SOURCE_PAGE_MAX, Math.trunc(Number.isFinite(page.limit) ? page.limit! : NATIVE_SOURCE_PAGE_MAX)));
    const [afterAt, afterHandle] = NativeSourcePager.decodeCursor(page.after);
    const state = page.state && NativeSourcePager.states.has(page.state) ? page.state : null;
    const rows = await this.repository.page({ afterAt, afterHandle, state, limit });
    return rows.map(row => ({
      fileId: row.file_id, versionId: row.version_id, collectionId: row.collection_id, path: row.path, handle: row.source_handle, name: row.display_name,
      sourceRevision: row.source_revision, sourceHash: row.source_hash, state: row.state, lastError: row.last_error ?? undefined, recovery: row.recovery ?? {},
      cursor: Buffer.from(`${ row.created_at }|${ row.source_handle }`).toString('base64url'),
    }));
  }
}

/** Delegating shim for localManager.ts. */
export function decodeNativeSourceCursor(cursor:string | undefined):[string | null, string | null] {
  return NativeSourcePager.decodeCursor(cursor);
}

/** Delegating shim for localManager.ts: builds the pager from the passed-in pool or client. */
export function queryNativeSourcePage(db:NativeSourceQueryable, page:NativeSourcePage = {}):Promise<NativeSourcePageRow[]> {
  return new NativeSourcePager(new NativeSourcePageRepository(db)).page(page);
}
