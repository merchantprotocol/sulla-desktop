import fs from 'fs';
import path from 'path';

import { BaseTool, ToolResponse } from '../base';
import { resolveFsPath } from './path_utils';

export class FsListDirWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const targetPath = resolveFsPath(input.path);
    const rawDepth = Number(input.depth ?? 1);
    const maxDepth = Number.isFinite(rawDepth) ? Math.max(1, Math.floor(rawDepth)) : 1;

    const listRecursive = (dirPath: string, depth: number, baseDir: string): string[] => {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const lines: string[] = [];

      for (const entry of entries) {
        const absoluteEntryPath = path.join(dirPath, entry.name);
        const relativeEntryPath = path.relative(baseDir, absoluteEntryPath) || entry.name;
        lines.push(`${ entry.isDirectory() ? 'd' : '-' } ${ relativeEntryPath }`);

        if (entry.isDirectory() && depth > 1) {
          lines.push(...listRecursive(absoluteEntryPath, depth - 1, baseDir));
        }
      }

      return lines;
    };

    try {
      const lines = listRecursive(targetPath, maxDepth, targetPath);
      return {
        successBoolean: true,
        responseString: lines.join('\n'),
      };
    } catch (error: any) {
      return {
        successBoolean: false,
        responseString: `Failed to list directory at "${ targetPath }": ${ error.message }`,
      };
    }
  }
}
