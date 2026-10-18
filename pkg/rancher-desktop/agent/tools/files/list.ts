import { FilesTool } from './common';

import type { ToolResponse } from '../base';
export class FilesListWorker extends FilesTool { name = ''; description = ''; protected async _validatedCall(input:any):Promise<ToolResponse> { const rows = await this.containerJson(`/v1/files?collectionId=${ encodeURIComponent(input.collection_id) }&path=${ encodeURIComponent(input.prefix ?? '') }&trash=false`, input); return { successBoolean: true, responseString: JSON.stringify(rows) } } }
