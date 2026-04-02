import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { BaseTool, ToolResponse } from '../base';

/**
 * ReadFile Tool — read file contents with optional line range.
 * Returns the content along with total line count so the caller
 * knows how much of the file they're seeing.
 */
export class ReadFileWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    let filePath: string = input.path || input.filePath || '';

    if (!filePath) {
      return { successBoolean: false, responseString: 'Missing required field: path' };
    }

    // Expand ~ to home directory
    if (filePath.startsWith('~/')) {
      filePath = filePath.replace('~', os.homedir());
    } else if (filePath === '~') {
      filePath = os.homedir();
    }

    // Resolve to absolute
    filePath = path.resolve(filePath);

    // Safety: block obvious bad paths
    if (filePath.includes('..') && !filePath.startsWith(os.homedir())) {
      return { successBoolean: false, responseString: 'Path traversal not allowed outside home directory' };
    }

    try {
      if (!fs.existsSync(filePath)) {
        return { successBoolean: false, responseString: `File not found: ${ filePath }` };
      }

      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        // List directory contents instead
        const entries = fs.readdirSync(filePath);
        return {
          successBoolean: true,
          responseString: `Directory listing (${ entries.length } entries):\n${ entries.join('\n') }`,
        };
      }

      // Read the file
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      const totalLines = lines.length;

      const startLine = Math.max(1, input.startLine || 1);
      const endLine = Math.min(totalLines, input.endLine || totalLines);

      // Extract requested range (1-indexed)
      const selectedLines = lines.slice(startLine - 1, endLine);

      // Format with line numbers
      const numbered = selectedLines
        .map((line, i) => `${ startLine + i }: ${ line }`)
        .join('\n');

      const rangeInfo = (startLine > 1 || endLine < totalLines)
        ? ` (showing lines ${ startLine }-${ endLine })`
        : '';

      return {
        successBoolean: true,
        responseString: `${ filePath } — ${ totalLines } total lines${ rangeInfo }\n\n${ numbered }`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Failed to read file: ${ error instanceof Error ? error.message : String(error) }`,
      };
    }
  }
}
