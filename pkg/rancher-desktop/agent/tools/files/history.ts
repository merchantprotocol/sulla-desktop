import { FilesTool } from './common';

import type { ToolResponse } from '../base';
export class FilesHistoryWorker extends FilesTool { name = ''; description = ''; protected async _validatedCall(input:any):Promise<ToolResponse> { return { successBoolean: true, responseString: JSON.stringify(await this.containerJson(`/v1/files/${ encodeURIComponent(input.file_id) }/history`, input)) } } }
