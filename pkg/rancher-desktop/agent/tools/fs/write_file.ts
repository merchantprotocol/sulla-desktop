import fs from 'fs';
import path from 'path';

import { BaseTool, ToolResponse } from '../base';
import { resolveFsPath } from './path_utils';

export class FsWriteFileWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const targetPath = resolveFsPath(input.path);
    const content = String(input.content ?? '');
    const createDirs = input.createDirs !== false;

    try {
      if (createDirs) {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      }
      fs.writeFileSync(targetPath, content, 'utf8');
      return {
        successBoolean: true,
        responseString: `Wrote ${ content.length } bytes to ${ targetPath }`,
      };
    } catch (error: any) {
      return {
        successBoolean: false,
        responseString: `Failed to write file at "${ targetPath }": ${ error.message }`,
      };
    }
  }
}
