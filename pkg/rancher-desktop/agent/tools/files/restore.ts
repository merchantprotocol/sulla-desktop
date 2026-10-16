import { FilesTool, filesService } from './common';

import type { ToolResponse } from '../base';
export class FilesRestoreWorker extends FilesTool { name = ''; description = ''; protected async _validatedCall(input:any):Promise<ToolResponse> { return { successBoolean: true, responseString: JSON.stringify(await filesService().restore(this.context(input), input.file_id, input.version_id)) } } }
