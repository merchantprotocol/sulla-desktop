import { FilesTool, filesService } from './common';

import type { ToolResponse } from '../base';
export class FilesSearchWorker extends FilesTool { name = ''; description = ''; protected async _validatedCall(input:any):Promise<ToolResponse> { const filters = { folder: input.folder, type: input.type, person: input.person, from: input.from ? new Date(input.from) : undefined, to: input.to ? new Date(input.to) : undefined }; const rows = input.collection_id ? await filesService().search(this.context(input), input.collection_id, input.query, filters) : await filesService().searchAll(this.context(input), input.query, filters); return { successBoolean: true, responseString: JSON.stringify(rows) } } }
