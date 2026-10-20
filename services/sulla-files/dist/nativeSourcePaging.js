/**
 * Keyset-paginated native source inventory (ORDER BY created_at, source_handle
 * LIMIT n, backed by files_native_sources_created). It replaces an unbounded
 * full-table sort that Desktop polled every 250 ms.
 */
export const NATIVE_SOURCE_PAGE_MAX = 1_000;
const STATES = new Set(['active', 'conflict', 'reselect-required', 'revoked']);
/** Opaque keyset cursor: base64url("<ISO created_at>|<source handle>"). Invalid cursors start from the beginning. */
export function decodeNativeSourceCursor(cursor) {
    if (!cursor)
        return [null, null];
    const [at, handle] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (!at || Number.isNaN(Date.parse(at)) || !/^[A-Za-z0-9_-]{43}$/.test(handle ?? ''))
        return [null, null];
    return [at, handle];
}
export const NATIVE_SOURCE_PAGE_SQL = `SELECT n.file_id::text,f.current_version_id::text AS version_id,f.collection_id,f.path,n.source_handle,n.display_name,n.source_revision,n.source_hash,n.state,n.last_error,n.recovery,
    to_char(n.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
  FROM files_native_sources n JOIN files f ON f.id=n.file_id
  WHERE ($1::timestamptz IS NULL OR (n.created_at,n.source_handle) > ($1::timestamptz,$2::text)) AND ($3::text IS NULL OR n.state=$3)
  ORDER BY n.created_at,n.source_handle LIMIT $4`;
export async function queryNativeSourcePage(db, page = {}) {
    const limit = Math.max(1, Math.min(NATIVE_SOURCE_PAGE_MAX, Math.trunc(Number.isFinite(page.limit) ? page.limit : NATIVE_SOURCE_PAGE_MAX)));
    const [afterAt, afterHandle] = decodeNativeSourceCursor(page.after);
    const state = page.state && STATES.has(page.state) ? page.state : null;
    const rows = await db.query(NATIVE_SOURCE_PAGE_SQL, [afterAt, afterHandle, state, limit]);
    return rows.rows.map(row => ({
        fileId: row.file_id, versionId: row.version_id, collectionId: row.collection_id, path: row.path, handle: row.source_handle, name: row.display_name,
        sourceRevision: row.source_revision, sourceHash: row.source_hash, state: row.state, lastError: row.last_error ?? undefined, recovery: row.recovery ?? {},
        cursor: Buffer.from(`${row.created_at}|${row.source_handle}`).toString('base64url'),
    }));
}
