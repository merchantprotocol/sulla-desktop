// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { BaseTool, ToolResponse } from '../base';
import { runDockerCommand } from './runDockerCommand';

/**
 * Docker Build Tool - Worker class for execution
 */
export class DockerBuildWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { path, tag, options } = input;

    const args = ['build'];
    if (options) {
      args.push(...options.split(' '));
    }
    args.push('-t', tag, path);

    try {
      const res = await runDockerCommand(args, { timeoutMs: 300000, maxOutputChars: 160_000 }); // Longer timeout for building

      if (res.exitCode !== 0) {
        return {
          successBoolean: false,
          responseString: `Error building docker image: ${ res.stderr || res.stdout }`,
        };
      }

      return {
        successBoolean: true,
        responseString: `Docker image built successfully. Tag: ${ tag }, Path: ${ path }\nBuild Output:\n${ res.stdout }`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error executing docker build: ${ (error as Error).message }`,
      };
    }
  }
}
