import { FilesTool, filesService } from './common';

import type { ToolResponse } from '../base';
export class FilesPutWorker extends FilesTool {
  name = ''; description = '';
  protected async _validatedCall(input:any):Promise<ToolResponse> {
    if (!input.content && !input.content_base64) throw new Error('content or content_base64 is required');
    const bytes = Buffer.from(input.content_base64 ?? input.content, input.content_base64 ? 'base64' : 'utf8');
    const result = await filesService().put(this.context(input), { collectionId: input.collection_id, path: input.path, bytes, mime: input.mime ?? (input.content_base64 ? 'application/octet-stream' : 'text/markdown'), message: input.message, derivedFrom: input.derived_from });
    return { successBoolean: true, responseString: JSON.stringify(result) };
  }
}
