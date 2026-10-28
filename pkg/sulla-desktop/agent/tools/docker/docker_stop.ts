// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { BaseTool, ToolResponse } from '../base';
import { runDockerCommand } from './runDockerCommand';

/**
 * Docker Stop Tool - Worker class for execution
 */
export class DockerStopWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { container } = input;

    try {
      const res = await runDockerCommand(['stop', container], { timeoutMs: 60000, maxOutputChars: 160_000 });

      if (res.exitCode !== 0) {
        return {
          successBoolean: false,
          responseString: `Error stopping docker container: ${ res.stderr || res.stdout }`,
        };
      }

      return {
        successBoolean: true,
        responseString: `Container stopped successfully. Container: ${ container }`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error executing docker stop: ${ (error as Error).message }`,
      };
    }
  }
}
