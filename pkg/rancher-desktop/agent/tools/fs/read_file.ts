import fs from 'fs';

import { BaseTool, ToolResponse } from '../base';
import { resolveFsPath } from './path_utils';

export class FsReadFileWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const targetPath = resolveFsPath(input.path);

    try {
      const content = fs.readFileSync(targetPath, 'utf8');
      return {
        successBoolean: true,
        responseString: content,
      };
    } catch (error: any) {
      return {
        successBoolean: false,
        responseString: `Failed to read file at "${ targetPath }": ${ error.message }`,
      };
    }
  }
}
