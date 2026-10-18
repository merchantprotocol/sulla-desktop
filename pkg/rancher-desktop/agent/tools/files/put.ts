import { FilesTool } from './common';

import type { ToolResponse } from '../base';
export class FilesPutWorker extends FilesTool {
  name = ''; description = '';
  protected async _validatedCall(input:any):Promise<ToolResponse> {
    if (input.content === undefined && input.content_base64 === undefined) throw new Error('content or content_base64 is required');
    const result = await this.containerJson('/v1/agent-files', input, {
      method: 'POST',
      body: JSON.stringify({
        collectionId: input.collection_id,
        path: input.path,
        content: input.content,
        contentBase64: input.content_base64,
        mime: input.mime ?? (input.content_base64 ? 'application/octet-stream' : 'text/markdown'),
        message: input.message,
        derivedFrom: input.derived_from,
      }),
    });
    return { successBoolean: true, responseString: JSON.stringify(result) };
  }
}
