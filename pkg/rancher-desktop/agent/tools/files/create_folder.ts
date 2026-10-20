import { FilesTool } from './common';

import type { ToolResponse } from '../base';

export class FilesCreateFolderWorker extends FilesTool {
  name = '';
  description = '';

  protected async _validatedCall(input:any):Promise<ToolResponse> {
    const result=await this.containerJson('/v1/folders',input,{method:'POST',body:JSON.stringify({collectionId:input.collection_id,path:input.path,description:input.description,namingHint:input.naming_hint})});

    return {successBoolean:true,responseString:JSON.stringify(result)};
  }
}
