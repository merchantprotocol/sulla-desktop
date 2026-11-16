// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { FilePreviewService, type FileContent } from './Services/FilePreviewService.js';

import type { Config } from './config.js';
import type { Store } from './store.js';
import type pg from 'pg';

export { FilePreviewService, type FileContent } from './Services/FilePreviewService.js';

/** Delegating shim for app.ts; the app.ts split should inject one FilePreviewService instead. */
export function loadFileContent(db:pg.Pool, config:Config, store:Store, fileId:string, versionId?:string):Promise<FileContent | undefined> {
  return new FilePreviewService(db, config, store).loadFileContent(fileId, versionId);
}

/** Delegating shim for app.ts. */
export function thumbnail(db:pg.Pool, config:Config, store:Store, fileId:string, versionId?:string):Promise<FileContent | undefined> {
  return new FilePreviewService(db, config, store).thumbnail(fileId, versionId);
}
