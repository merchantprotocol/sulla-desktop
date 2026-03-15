import fs from 'fs';
import path from 'path';

import { BaseTool, ToolResponse } from '../base';
import { resolveFsPath } from './path_utils';

export class FsMovePathWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const sourcePath = resolveFsPath(input.sourcePath);
    const destinationPath = resolveFsPath(input.destinationPath);
    const createDirs = input.createDirs !== false;

    try {
      if (createDirs) {
        fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      }
      fs.renameSync(sourcePath, destinationPath);
      return {
        successBoolean: true,
        responseString: `Moved ${ sourcePath } to ${ destinationPath }`,
      };
    } catch (error: any) {
      return {
        successBoolean: false,
        responseString: `Failed to move path from "${ sourcePath }" to "${ destinationPath }": ${ error.message }`,
      };
    }
  }
}
