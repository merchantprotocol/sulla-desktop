import { FilesTool } from './common';
import type { ToolResponse } from '../base';

export class FilesCollectionsWorker extends FilesTool {
  name = ''; description = '';
  protected async _validatedCall(input:any):Promise<ToolResponse> {
    const collections = await this.containerJson<any[]>('/v1/collections', input);
    return { successBoolean: true, responseString: JSON.stringify(collections.map(collection => ({
      id: collection.id, name: collection.name, systemArea: collection.systemArea ?? null, role: collection.access_role ?? null,
    }))) };
  }
}
