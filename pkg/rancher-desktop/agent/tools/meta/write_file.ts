import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { BaseTool, ToolResponse } from '../base';

/**
 * WriteFile Tool — write or overwrite file contents.
 * Creates parent directories if they don't exist.
 * Scoped to the home directory for safety.
 */
export class WriteFileWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    let filePath: string = input.path || input.filePath || '';
    const content: string = input.content;

    if (!filePath) {
      return { successBoolean: false, responseString: 'Missing required field: path' };
    }

    if (content === undefined || content === null) {
      return { successBoolean: false, responseString: 'Missing required field: content' };
    }

    // Expand ~ to home directory
    if (filePath.startsWith('~/')) {
      filePath = filePath.replace('~', os.homedir());
    } else if (filePath === '~') {
      return { successBoolean: false, responseString: 'Cannot write to home directory itself' };
    }

    // Resolve to absolute
    filePath = path.resolve(filePath);

    // Safety: block paths outside home directory
    if (!filePath.startsWith(os.homedir())) {
      return { successBoolean: false, responseString: 'Write operations are restricted to the home directory' };
    }

    try {
      // Create parent directories if needed
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(filePath, String(content), 'utf-8');

      const lines = String(content).split('\n').length;

      return {
        successBoolean: true,
        responseString: `Wrote ${ lines } lines to ${ filePath }`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Failed to write file: ${ error instanceof Error ? error.message : String(error) }`,
      };
    }
  }
}
