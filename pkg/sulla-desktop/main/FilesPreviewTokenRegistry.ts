// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { randomUUID } from 'node:crypto';

export interface FilesPreviewBinding { collectionId:string; rootFolder:string; rootDocument:string; expiresAt:number }
export class FilesPreviewTokenRegistry {
  private readonly bindings = new Map<string, FilesPreviewBinding>();
  constructor(private readonly now:() => number = () => Date.now(), private readonly ttlMs = 60 * 60_000) {}
  issue(collectionId:string, rootFolder:string, rootDocument:string):string {
    const token = randomUUID();
    this.bindings.set(token, { collectionId, rootFolder, rootDocument, expiresAt:this.now() + this.ttlMs });
    return token;
  }
  resolve(token:string):FilesPreviewBinding | undefined {
    const binding = this.bindings.get(token);
    if (!binding || binding.expiresAt <= this.now()) { this.bindings.delete(token); return undefined }
    binding.expiresAt = this.now() + this.ttlMs;
    return binding;
  }
  revoke(token:string):void { this.bindings.delete(token) }
}
