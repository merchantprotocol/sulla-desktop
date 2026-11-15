// Sulla Desktop · https://sulladesktop.com.
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export interface ListingPageResponse {
  setHeader(name:string,value:string):unknown;
}

export class ListingPage {
  static readonly defaultSize=250;
  static readonly maxSize=500;
  static readonly legacyMaxRows=20_000;

  static isRequested(limitValue:unknown,cursorValue:unknown):boolean { return limitValue !== undefined || cursorValue !== undefined }

  private constructor(readonly limit:number, readonly after:string) {}

  static parse(limitValue:unknown,cursorValue:unknown):ListingPage {
    const requested=Number(limitValue ?? ListingPage.defaultSize);
    const limit=Number.isSafeInteger(requested) ? Math.min(ListingPage.maxSize,Math.max(1,requested)) : ListingPage.defaultSize;
    const cursor=typeof cursorValue==='string' ? cursorValue : '';
    let after='';
    if(cursor) {
      try { after=Buffer.from(cursor,'base64url').toString('utf8'); }
      catch { throw new Error('invalid listing cursor'); }
      if(!after || Buffer.from(after,'utf8').toString('base64url')!==cursor) throw new Error('invalid listing cursor');
    }
    return new ListingPage(limit,after);
  }

  apply(response:ListingPageResponse,hasMore:boolean,lastKey?:string):void {
    response.setHeader('X-Has-More',String(hasMore));
    if(hasMore && lastKey) response.setHeader('X-Next-Cursor',Buffer.from(lastKey,'utf8').toString('base64url'));
  }
}
