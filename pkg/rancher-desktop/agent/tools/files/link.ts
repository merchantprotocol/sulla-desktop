import { FilesTool, filesService } from './common';

import type { ToolResponse } from '../base';
export class FilesLinkWorker extends FilesTool { name = ''; description = ''; protected async _validatedCall(input:any):Promise<ToolResponse> { await filesService().link(this.context(input), input.file_id, input.target_file_id, input.kind); return { successBoolean: true, responseString: 'File link saved.' } } }
