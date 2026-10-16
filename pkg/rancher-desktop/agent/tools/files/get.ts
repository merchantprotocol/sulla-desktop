import { FilesTool, filesService } from './common';

import type { ToolResponse } from '../base';
export class FilesGetWorker extends FilesTool { name = ''; description = ''; protected async _validatedCall(input:any):Promise<ToolResponse> { const r = await filesService().get(this.context(input), input.file_id, input.version_id); return { successBoolean: true, responseString: JSON.stringify({ file: r.file, version: r.version, content_base64: Buffer.from(r.bytes).toString('base64') }) } } }
