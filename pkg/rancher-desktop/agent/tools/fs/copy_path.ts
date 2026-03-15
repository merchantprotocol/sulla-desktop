import fs from 'fs';
import path from 'path';

import { BaseTool, ToolResponse } from '../base';
import { resolveFsPath } from './path_utils';

export class FsCopyPathWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const sourcePath = resolveFsPath(input.sourcePath);
    const destinationPath = resolveFsPath(input.destinationPath);
    const recursive = input.recursive !== false;
    const overwrite = input.overwrite === true;
    const createDirs = input.createDirs !== false;

    try {
      if (createDirs) {
        fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      }
      fs.cpSync(sourcePath, destinationPath, { recursive, force: overwrite });
      return {
        successBoolean: true,
        responseString: `Copied ${ sourcePath } to ${ destinationPath }`,
      };
    } catch (error: any) {
      return {
        successBoolean: false,
        responseString: `Failed to copy path from "${ sourcePath }" to "${ destinationPath }": ${ error.message }`,
      };
    }
  }
}
