// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export type FilesListingRequest = (url:string) => Promise<Response>;

/**
 * Walks a keyset-paged Files listing (GET /v1/files, GET /v1/folders) one bounded
 * page at a time. Callers process each page with for-await, so memory held for the
 * listing is one page (<= pageSize rows), never the whole collection.
 *
 * An older Files service that ignores limit/cursor returns the full array with no
 * X-Next-Cursor header; the walk then ends after that single response, so the
 * helper stays correct against services in the field.
 */
export class FilesListingPager {
  static readonly pageSize = 250;

  constructor(
    private readonly request:FilesListingRequest,
    private readonly endpoint:string,
    private readonly parameters:URLSearchParams | Record<string, string>,
    private readonly pageSize = FilesListingPager.pageSize,
  ) {}

  /** Convenience for `new FilesListingPager(...).pages()`. */
  static pages<T>(request:FilesListingRequest, endpoint:string, parameters:URLSearchParams | Record<string, string>, pageSize?:number):AsyncGenerator<T[], void, void> {
    return new FilesListingPager(request, endpoint, parameters, pageSize).pages<T>();
  }

  /** True as soon as any row matches; stops fetching further pages. */
  static async some<T>(request:FilesListingRequest, endpoint:string, parameters:URLSearchParams | Record<string, string>, predicate:(row:T) => boolean):Promise<boolean> {
    for await (const rows of FilesListingPager.pages<T>(request, endpoint, parameters)) {
      if (rows.some(predicate)) return true;
    }
    return false;
  }

  async *pages<T>():AsyncGenerator<T[], void, void> {
    let cursor:string | null = null;
    while (true) {
      const query = new URLSearchParams(this.parameters);
      query.set('limit', String(this.pageSize));
      if (cursor) query.set('cursor', cursor);
      const response = await this.request(`${ this.endpoint }?${ query }`);
      if (!response.ok) throw new Error(`Files listing failed (${ response.status })`);
      const rows = await response.json() as T[];
      if (!Array.isArray(rows)) throw new Error('Files listing returned a non-array page');
      yield rows;
      const next = response.headers.get('X-Next-Cursor');
      if (!next || response.headers.get('X-Has-More') !== 'true') return;
      // Keyset cursors only move forward; a repeat would loop forever.
      if (next === cursor) throw new Error('Files listing returned a repeated cursor');
      cursor = next;
    }
  }
}
