// Sulla Desktop · https://sulladesktop.com.
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export interface FileListingScopeInput {
  collectionId:string;
  /** Clean collection-relative folder path; '' is the collection root. */
  path:string;
  /** true: only files whose parent folder is exactly `path`. false: every file below `path` (legacy subtree listing). */
  childrenOnly:boolean;
  trash:boolean;
  deviceId?:string;
  /** Keyset cursor: only paths strictly after this one. '' starts at the first page. */
  after:string;
  /** Maximum rows to fetch (callers ask for page size + 1 to detect another page). */
  limit:number;
}

export interface SqlFragment { where:string; orderLimit:string; values:unknown[] }

/**
 * Builds the WHERE / ORDER / LIMIT for GET /v1/files over `files f` (and `file_versions v` when a device
 * filter is used). Direct-children listings compare the generated `parent_path` column for equality, so a
 * folder named `a` never matches `a-b/…`, `a b/…` or grandchildren `a/b/…`, and paging stays on the
 * `(collection_id,parent_path,path)` index however many files sort before the folder.
 */
export class FileListingQuery {
  build(input:FileListingScopeInput):SqlFragment {
    const values:unknown[] = [input.collectionId];
    const bind = (value:unknown) => `$${ values.push(value) }`;
    const clauses = [
      'NOT EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id)',
      'f.collection_id=$1',
    ];
    if (input.childrenOnly) clauses.push(`f.parent_path=${ bind(input.path) }`);
    else if (input.path) clauses.push(`starts_with(f.path, ${ bind(`${ input.path }/`) })`);
    clauses.push(`f.path>${ bind(input.after) }`);
    clauses.push(input.trash ? 'f.deleted_at IS NOT NULL' : 'f.deleted_at IS NULL');
    if (input.deviceId) clauses.push(`v.device_id=${ bind(input.deviceId) }`);
    const limit = Math.max(1, Math.floor(input.limit));
    return { where: clauses.join(' AND '), orderLimit: `ORDER BY f.path LIMIT ${ bind(limit) }`, values };
  }
}
