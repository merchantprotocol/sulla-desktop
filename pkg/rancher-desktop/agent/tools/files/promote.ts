import { FilesTool } from './common';

import type { ToolResponse } from '../base';
export class FilesPromoteWorker extends FilesTool {
  name = ''; description = '';
  protected async _validatedCall(input:any):Promise<ToolResponse> {
    if (input.agent_run_id) {
      const result = await this.containerJson<{ count:number }>(`/v1/agent-runs/${ encodeURIComponent(input.agent_run_id) }/keep`, input, { method: 'POST', body: JSON.stringify({ collectionId: input.target_collection_id }) });
      const count = result.count;
      return { successBoolean: true, responseString: `Promoted ${ count } scratch files from the run with fresh encryption in the destination collection.` };
    }
    if (!input.file_id) throw new Error('file_id or agent_run_id is required');
    await this.containerJson(`/v1/agent-files/${ encodeURIComponent(input.file_id) }/keep`, input, { method: 'POST', body: JSON.stringify({ collectionId: input.target_collection_id, path: input.path }) });
    return { successBoolean: true, responseString: 'Scratch file promoted with fresh encryption in the destination collection.' };
  }
}
