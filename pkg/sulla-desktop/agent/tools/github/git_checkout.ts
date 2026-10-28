// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { BaseTool, ToolResponse } from '../base';
import { runCommand } from '../util/CommandRunner';

/**
 * Git Checkout Tool - Restore files from a commit or branch, or discard working tree changes.
 * Runs inside the Sulla VM for filesystem consistency with exec tool.
 */
export class GitCheckoutWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { absolutePath, files, ref = 'HEAD' } = input;

    try {
      // Get repo root
      const rootResult = await runCommand(
        `git -C "${ absolutePath }" rev-parse --show-toplevel`,
        [],
        { runInGuest: true, timeoutMs: 30_000 },
      );

      if (rootResult.exitCode !== 0) {
        return { successBoolean: false, responseString: `Git error: ${ rootResult.stderr || rootResult.stdout }` };
      }

      const repoRoot = rootResult.stdout.trim();

      if (!files || files.length === 0) {
        return { successBoolean: false, responseString: 'No files specified to restore.' };
      }

      const fileArgs = files.map((f: string) => `"${ f }"`).join(' ');
      const cmd = `git -C "${ repoRoot }" checkout ${ ref } -- ${ fileArgs }`;

      const result = await runCommand(cmd, [], { runInGuest: true, timeoutMs: 30_000 });

      if (result.exitCode !== 0) {
        return { successBoolean: false, responseString: `Git checkout failed: ${ result.stderr || result.stdout }` };
      }

      return { successBoolean: true, responseString: `Restored ${ files.length } file(s) from ${ ref }.` };
    } catch (error: any) {
      return { successBoolean: false, responseString: `Git checkout failed: ${ error.message }` };
    }
  }
}
