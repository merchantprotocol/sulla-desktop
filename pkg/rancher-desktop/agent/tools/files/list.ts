import { FilesTool, filesService } from './common';

import type { ToolResponse } from '../base';
export class FilesListWorker extends FilesTool { name = ''; description = ''; protected async _validatedCall(input:any):Promise<ToolResponse> { const rows = await filesService().list(this.context(input), input.collection_id, input.prefix); return { successBoolean: true, responseString: JSON.stringify(rows) } } }
