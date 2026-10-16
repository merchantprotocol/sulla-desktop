import { FilesTool } from './common';

import { getCurrentAccessToken } from '@pkg/main/sullaCloudAuth';

import type { ToolResponse } from '../base';

export class FilesRevokeLinkWorker extends FilesTool {
  name = '';
  description = '';
  protected async _validatedCall(input:any):Promise<ToolResponse> {
    const token = await getCurrentAccessToken();
    try { await this.containerRequest(`/v1/links/${ encodeURIComponent(input.id) }`, input, { method: 'DELETE', headers: token ? { 'X-Sulla-Cloud-Token': token } : {} }); return { successBoolean: true, responseString: 'Share link revoked.' } } catch (error) { return { successBoolean: false, responseString: error instanceof Error ? error.message : String(error) } }
  }
}
