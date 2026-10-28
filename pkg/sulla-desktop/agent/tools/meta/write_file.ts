// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { BaseTool, ToolResponse } from '../base';
import { hasContainerFileRuntime, writeContainerPath, writeGuestPath } from '../util/containerFileRuntime';

/**
 * WriteFile Tool — write or overwrite file contents.
 * Creates parent directories if they don't exist.
 * Scoped to the home directory for safety.
 */
export class WriteFileWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const filePath: string = input.path || input.filePath || '';
    const content: string = input.content;

    if (!filePath) {
      return { successBoolean: false, responseString: 'Missing required field: path' };
    }

    if (content === undefined || content === null) {
      return { successBoolean: false, responseString: 'Missing required field: content' };
    }

    try {
      const result = await (hasContainerFileRuntime() ? writeContainerPath(filePath, String(content)) : writeGuestPath(filePath, String(content)));

      return { successBoolean: true, responseString: `Wrote ${ result.lines } lines to ${ result.path }` };
    } catch (error) {
      return { successBoolean: false, responseString: `Failed to write guest file: ${ error instanceof Error ? error.message : String(error) }` };
    }
  }
}
