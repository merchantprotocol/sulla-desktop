import { FilesTool } from './common';

import type { ToolResponse } from '../base';
export class FilesGetWorker extends FilesTool { name = ''; description = ''; protected async _validatedCall(input:any):Promise<ToolResponse> { const query = input.version_id ? `?versionId=${ encodeURIComponent(input.version_id) }` : ''; const r = await this.containerJson(`/v1/agent-files/${ encodeURIComponent(input.file_id) }${ query }`, input); return { successBoolean: true, responseString: JSON.stringify(r) } } }
