import { FilesTool } from './common';
import type { ToolResponse } from '../base';
export class FilesRestoreWorker extends FilesTool {
  name = ''; description = '';
  protected async _validatedCall(input:any):Promise<ToolResponse> {
    const resolved = await this.resolvePath(input);
    const fileId = resolved?.fileId ?? input.file_id;
    if (!fileId) throw new Error('path resolving to a file or file_id is required');
    return { successBoolean: true, responseString: JSON.stringify(await this.containerJson(`/v1/files/${ encodeURIComponent(fileId) }/restore`, input, { method: 'POST', body: JSON.stringify({ versionId: input.version_id }) })) };
  }
}
