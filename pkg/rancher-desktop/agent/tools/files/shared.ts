import { FilesTool } from './common';

import type { ToolResponse } from '../base';

export class FilesSharedWorker extends FilesTool {
  name = '';
  description = '';
  protected async _validatedCall(input:any):Promise<ToolResponse> {
    try {
      const response = await this.containerRequest('/v1/links?createdBy=me', input);
      return { successBoolean: true, responseString: await response.text() };
    } catch (error) { return { successBoolean: false, responseString: error instanceof Error ? error.message : String(error) } }
  }
}
