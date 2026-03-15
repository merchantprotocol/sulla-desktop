import fs from 'fs';

import { BaseTool, ToolResponse } from '../base';
import { resolveFsPath } from './path_utils';

export class FsMkdirWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const targetPath = resolveFsPath(input.path);
    const recursive = input.recursive !== false;

    try {
      fs.mkdirSync(targetPath, { recursive });
      return {
        successBoolean: true,
        responseString: `Created directory at ${ targetPath }`,
      };
    } catch (error: any) {
      return {
        successBoolean: false,
        responseString: `Failed to create directory at "${ targetPath }": ${ error.message }`,
      };
    }
  }
}
