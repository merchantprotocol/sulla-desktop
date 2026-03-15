import fs from 'fs';

import { BaseTool, ToolResponse } from '../base';
import { resolveFsPath } from './path_utils';

export class FsDeletePathWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const targetPath = resolveFsPath(input.path);
    const recursive = input.recursive === true;
    const force = input.force !== false;

    try {
      fs.rmSync(targetPath, { recursive, force });
      return {
        successBoolean: true,
        responseString: `Deleted path ${ targetPath }`,
      };
    } catch (error: any) {
      return {
        successBoolean: false,
        responseString: `Failed to delete path "${ targetPath }": ${ error.message }`,
      };
    }
  }
}
