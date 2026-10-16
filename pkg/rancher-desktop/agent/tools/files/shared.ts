import { FilesTool } from './common';

import { getCurrentAccessToken } from '@pkg/main/sullaCloudAuth';

import type { ToolResponse } from '../base';

export class FilesSharedWorker extends FilesTool {
  name = '';
  description = '';
  protected async _validatedCall(input:any):Promise<ToolResponse> {
    const token = await getCurrentAccessToken();
    try {
      const response = await this.containerRequest('/v1/links?createdBy=me', input, { headers: token ? { 'X-Sulla-Cloud-Token': token } : {} });
      return { successBoolean: true, responseString: await response.text() };
    } catch (error) { return { successBoolean: false, responseString: error instanceof Error ? error.message : String(error) } }
  }
}
