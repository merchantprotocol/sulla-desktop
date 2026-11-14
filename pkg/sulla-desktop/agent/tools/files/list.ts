// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { FilesTool } from './common';
import type { ToolResponse } from '../base';
import { addChatLinks } from './chatLink';

/** Same listing the File Manager shows, capped so large collections stay readable. */
export class FilesListWorker extends FilesTool {
  name = ''; description = '';
  protected async _validatedCall(input:any):Promise<ToolResponse> {
    if (!input.collection_id && !input.path) throw new Error('collection_id or path is required');
    if (!input.collection_id && input.path) {
      const resolved = await this.resolvePath(input);
      if (!resolved) throw new Error('That Sulla Files path was not found');
      input = { ...input, collection_id: resolved.collectionId, path: resolved.kind === 'file' ? (resolved.folderPath ?? '') : (resolved.folderPath ?? '') };
    }
    const suppliedPath = typeof input.path === 'string' ? input.path.replaceAll('\\', '/').replace(/^\/mnt\/sulla-files\//, '').replace(/^\/+/, '') : '';
    const collectionId = input.collection_id || (await this.containerJson<any[]>('/v1/collections', input)).find(collection => !collection.systemArea && (collection.is_default || collection.explorer_path === ''))?.id;
    if (!collectionId) throw new Error('Home collection is unavailable');
    const files = await this.containerJson<any[]>(`/v1/files?collectionId=${ encodeURIComponent(collectionId) }&path=${ encodeURIComponent(suppliedPath) }&trash=${ input.trash === true }`, input);
    const limit = Math.min(Math.max(Number(input.limit) || 200, 1), 2000);
    return { successBoolean: true, responseString: JSON.stringify({
      total: files.length,
      files: files.slice(0, limit).map(file => addChatLinks({ id: file.id, path: file.path, name: file.name, versionId: file.current_version_id ?? file.version_id, mime: file.mime, size: file.size, updatedAt: file.updated_at ?? file.updatedAt })),
    }) };
  }
}
