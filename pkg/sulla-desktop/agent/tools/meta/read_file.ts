// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { BaseTool, ToolResponse } from '../base';
import { hasContainerFileRuntime, readContainerPath, readGuestPath } from '../util/containerFileRuntime';

/**
 * ReadFile Tool — read file contents with optional line range.
 * Returns the content along with total line count so the caller
 * knows how much of the file they're seeing.
 */
export class ReadFileWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const filePath: string = input.path || input.filePath || '';

    if (!filePath) {
      return { successBoolean: false, responseString: 'Missing required field: path' };
    }

    try {
      const result = await (hasContainerFileRuntime() ? readContainerPath(filePath) : readGuestPath(filePath));
      if (result.kind === 'directory') {
        return { successBoolean: true, responseString: `Directory listing (${ result.entries?.length ?? 0 } entries):\n${ (result.entries ?? []).join('\n') }` };
      }
      const lines = (result.content ?? '').split('\n');
      const totalLines = result.totalLines ?? lines.length;
      const startLine = Math.max(1, input.startLine || 1);
      const endLine = Math.min(totalLines, input.endLine || totalLines);
      const numbered = lines.slice(startLine - 1, endLine).map((line, index) => `${ startLine + index }: ${ line }`).join('\n');
      const rangeInfo = startLine > 1 || endLine < totalLines ? ` (showing lines ${ startLine }-${ endLine })` : '';

      return { successBoolean: true, responseString: `${ result.path } — ${ totalLines } total lines${ rangeInfo }\n\n${ numbered }` };
    } catch (error) {
      return { successBoolean: false, responseString: `Failed to read guest file: ${ error instanceof Error ? error.message : String(error) }` };
    }
  }
}
