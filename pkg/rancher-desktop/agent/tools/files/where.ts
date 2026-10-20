import { FilesTool } from './common';

import type { ToolResponse } from '../base';

export class FilesWhereWorker extends FilesTool {
  name = '';
  description = '';

  protected async _validatedCall(input:any):Promise<ToolResponse> {
    const query = new URLSearchParams({ what:String(input.what), ...(input.kind ? {kind:String(input.kind)} : {}), ...(input.project ? {project:String(input.project)} : {}) });
    const result = await this.containerJson(`/v1/folders/where?${query}`, input);

    return { successBoolean:true, responseString:JSON.stringify(result) };
  }
}
