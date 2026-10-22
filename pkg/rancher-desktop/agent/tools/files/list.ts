import { FilesTool } from './common';
import type { ToolResponse } from '../base';

/** Same listing the File Manager shows, capped so large collections stay readable. */
export class FilesListWorker extends FilesTool {
  name = ''; description = '';
  protected async _validatedCall(input:any):Promise<ToolResponse> {
    if (!input.collection_id) throw new Error('collection_id is required; use files_collections to find it');
    const files = await this.containerJson<any[]>(`/v1/files?collectionId=${ encodeURIComponent(input.collection_id) }&path=${ encodeURIComponent(input.path ?? '') }&trash=${ input.trash === true }`, input);
    const limit = Math.min(Math.max(Number(input.limit) || 200, 1), 2000);
    return { successBoolean: true, responseString: JSON.stringify({
      total: files.length,
      files: files.slice(0, limit).map(file => ({ id: file.id, path: file.path, size: file.size, updatedAt: file.updated_at ?? file.updatedAt })),
    }) };
  }
}
