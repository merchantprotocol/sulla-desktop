// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { BaseTool, ToolResponse } from '../base';
import { runDockerCommand } from './runDockerCommand';
import { AgentDockerRunPolicy } from './AgentDockerRunPolicy';
import { JobMessagingCheckinWriter } from './JobMessagingCheckinWriter';
import { PersistentContainerAuditor } from './PersistentContainerAuditor';

/**
 * Docker Run Tool - Worker class for execution
 */
export class DockerRunWorker extends BaseTool {
  name = '';
  description = '';

  constructor(
    private readonly policy = new AgentDockerRunPolicy(),
    private readonly auditor = new PersistentContainerAuditor(new JobMessagingCheckinWriter()),
  ) {
    super();
  }

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { image, name, command } = input;
    const metadata = this.state?.metadata ?? {};
    const identity = {
      jobId: String(metadata.jobId ?? metadata.threadId ?? 'unknown'),
      agentId: String(metadata.agentId ?? metadata.wsChannel ?? 'unknown'),
    };
    let policyResult;
    try {
      policyResult = this.policy.apply(input, identity);
    } catch (error) {
      return { successBoolean: false, responseString: (error as Error).message };
    }

    const args = ['run', ...policyResult.options];
    if (name) {
      args.push('--name', name);
    }
    args.push(image);
    if (command) {
      args.push(...command.split(' '));
    }

    try {
      const res = await runDockerCommand(args, { timeoutMs: 120000, maxOutputChars: 160_000 }); // Longer timeout for running containers

      if (res.exitCode !== 0) {
        return {
          successBoolean: false,
          responseString: `Error running docker run: ${ res.stderr || res.stdout }`,
        };
      }

      const containerId = res.stdout.trim();
      if (input.persistent === true) {
        await this.auditor.record(metadata.threadId, 'docker_run', String(input.reason).trim(), policyResult.labels);
      }
      return {
        successBoolean: true,
        responseString: `Container started successfully. Image: ${ image }, Container ID: ${ containerId }, Labels: ${ JSON.stringify(policyResult.labels) }`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error executing docker run: ${ (error as Error).message }`,
      };
    }
  }
}
