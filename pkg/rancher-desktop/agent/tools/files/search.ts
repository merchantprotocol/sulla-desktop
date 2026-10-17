import { FilesTool } from './common';

import type { ToolResponse } from '../base';
export class FilesSearchWorker extends FilesTool { name = ''; description = ''; protected async _validatedCall(input:any):Promise<ToolResponse> { const rows = await this.containerJson('/v1/search', input, { method: 'POST', body: JSON.stringify({ collectionId: input.collection_id, query: input.query, folder: input.folder, type: input.type, person: input.person, from: input.from, to: input.to }) }); return { successBoolean: true, responseString: JSON.stringify(rows) } } }
