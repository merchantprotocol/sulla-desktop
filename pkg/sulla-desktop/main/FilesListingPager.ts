// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Streams keyset listing responses one bounded page at a time. */
export class FilesListingPager {
  static readonly pageSize = 250;
  constructor(private readonly request:(url:string)=>Promise<Response>, private readonly endpoint:string, private readonly parameters:URLSearchParams, private readonly pageSize=FilesListingPager.pageSize) {}

  async *pages<T>():AsyncGenerator<T[],void,void> {
    let cursor:string|null=null;
    const seen=new Set<string>();
    while (true) {
      const query=new URLSearchParams(this.parameters);
      query.set('limit',String(this.pageSize));
      if(cursor) query.set('cursor',cursor);
      const response=await this.request(`${this.endpoint}?${query}`);
      if(!response.ok) throw new Error(`Files listing failed (${response.status})`);
      const rows=await response.json() as T[];
      yield rows;
      const next=response.headers.get('X-Next-Cursor') ?? response.headers.get('x-sulla-next-cursor');
      if(!next || rows.length===0) return;
      if(seen.has(next)) throw new Error('Files listing returned a repeated cursor');
      seen.add(next);
      cursor=next;
    }
  }
}
