import { FilesTool, filesService } from './common';

import type { ToolResponse } from '../base';
export class FilesPromoteWorker extends FilesTool { name = ''; description = ''; protected async _validatedCall(input:any):Promise<ToolResponse> { await filesService().promote(this.context(input), input.file_id, input.target_collection_id, input.path); return { successBoolean: true, responseString: 'Scratch file promoted without copying chunks.' } } }
