// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { BaseTool, ToolResponse } from '../base';

/** Deprecated conversation-id compatibility surface. */
export class SendAgentMessageWorker extends BaseTool {
  name = '';
  description = '';

  // Compatibility validation is synchronous, but BaseTool's contract is a Promise.
  protected _validatedCall(input: any): Promise<ToolResponse> {
    const { conversationId, message } = input;

    if (!conversationId || typeof conversationId !== 'string') {
      return Promise.resolve({
        successBoolean: false,
        responseString: 'conversationId is required (from start_agent_conversation).',
      });
    }
    if (!message || typeof message !== 'string') {
      return Promise.resolve({
        successBoolean: false,
        responseString: 'message is required (what to say to the sub-agent).',
      });
    }

    return Promise.resolve({
      successBoolean: false,
      responseString: `send_agent_message is deprecated. If "${ conversationId }" is an agent job, call send_job_message with { jobId: "${ conversationId }", message: ... }; otherwise launch a bounded task with spawn_agent.`,
    });
  }
}
