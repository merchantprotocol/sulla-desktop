import { FilesTool, filesService } from './common';

import type { ToolResponse } from '../base';
export class FilesSearchWorker extends FilesTool { name = ''; description = ''; protected async _validatedCall(input:any):Promise<ToolResponse> { return { successBoolean: true, responseString: JSON.stringify(await filesService().search(this.context(input), input.collection_id, input.query)) } } }
