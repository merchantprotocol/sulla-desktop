// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export interface NativeSourceQueryable { query(sql:string, values?:unknown[]):Promise<{ rows:any[] }> }

export interface NativeSourceKeyset { afterAt:string | null; afterHandle:string | null; state:string | null; limit:number }

/** One keyset page of the native source inventory (ORDER BY created_at, source_handle, backed by files_native_sources_created). */
export class NativeSourcePageRepository {
  static readonly pageSql = `SELECT n.file_id::text,f.current_version_id::text AS version_id,f.collection_id,f.path,n.source_handle,n.display_name,n.source_revision,n.source_hash,n.state,n.last_error,n.recovery,
    to_char(n.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
  FROM files_native_sources n JOIN files f ON f.id=n.file_id
  WHERE ($1::timestamptz IS NULL OR (n.created_at,n.source_handle) > ($1::timestamptz,$2::text)) AND ($3::text IS NULL OR n.state=$3)
  ORDER BY n.created_at,n.source_handle LIMIT $4`;

  constructor(private readonly db:NativeSourceQueryable) {}

  async page(keyset:NativeSourceKeyset):Promise<any[]> {
    return (await this.db.query(NativeSourcePageRepository.pageSql, [keyset.afterAt, keyset.afterHandle, keyset.state, keyset.limit])).rows;
  }
}
