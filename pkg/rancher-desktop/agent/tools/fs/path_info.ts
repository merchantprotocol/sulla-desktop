import fs from 'fs';

import { BaseTool, ToolResponse } from '../base';
import { resolveFsPath } from './path_utils';

export class FsPathInfoWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const targetPath = resolveFsPath(input.path);

    try {
      const stats = fs.statSync(targetPath);
      const payload = {
        path:   targetPath,
        exists: true,
        type:   stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other',
        size:   stats.size,
        mtime:  stats.mtime.toISOString(),
        ctime:  stats.ctime.toISOString(),
      };

      return {
        successBoolean: true,
        responseString: JSON.stringify(payload, null, 2),
      };
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        return {
          successBoolean: true,
          responseString: JSON.stringify({ path: targetPath, exists: false }, null, 2),
        };
      }

      return {
        successBoolean: false,
        responseString: `Failed to stat path "${ targetPath }": ${ error.message }`,
      };
    }
  }
}
