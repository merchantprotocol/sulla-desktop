import { FilesTool, filesService } from './common';

import type { ToolResponse } from '../base';
export class FilesPromoteWorker extends FilesTool {
  name = ''; description = '';
  protected async _validatedCall(input:any):Promise<ToolResponse> {
    if (input.agent_run_id) {
      const count = await filesService().keepScratchRun(this.context(input), input.agent_run_id, input.target_collection_id);
      return { successBoolean: true, responseString: `Promoted ${ count } scratch files from the run without copying chunks.` };
    }
    if (!input.file_id) throw new Error('file_id or agent_run_id is required');
    await filesService().promote(this.context(input), input.file_id, input.target_collection_id, input.path);
    return { successBoolean: true, responseString: 'Scratch file promoted without copying chunks.' };
  }
}
