// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export interface NativeSourceRevalidationResponse {
  ok:boolean;
  status:number;
}

export interface NativeSourceRevalidatorDependencies {
  post(handles:string[], replaceExisting:boolean):Promise<NativeSourceRevalidationResponse>;
}

/** Revalidates bounded pages; Files rejects a request with more than 256 handles. */
export class NativeSourceRevalidator {
  private static readonly PAGE_SIZE = 256;
  private readonly dependencies:NativeSourceRevalidatorDependencies;

  constructor(dependencies:NativeSourceRevalidatorDependencies) { this.dependencies = dependencies }

  async revalidate(handles:string[]):Promise<void> {
    // An empty page is meaningful: it marks persisted sessions from an earlier
    // Desktop process as requiring reselection.
    const pages = handles.length === 0 ? [[]] : this.pages(handles);

    for (const [index, page] of pages.entries()) {
      // The first page revokes handles left by an earlier Desktop process;
      // later pages extend the same new session instead of revoking earlier pages.
      const response = await this.dependencies.post(page, index === 0);

      if (!response.ok) throw new Error(`Native source sessions could not be revalidated (${ response.status })`);
    }
  }

  private pages(handles:string[]):string[][] {
    const pages:string[][] = [];

    for (let offset = 0; offset < handles.length; offset += NativeSourceRevalidator.PAGE_SIZE) {
      pages.push(handles.slice(offset, offset + NativeSourceRevalidator.PAGE_SIZE));
    }
    return pages;
  }
}
