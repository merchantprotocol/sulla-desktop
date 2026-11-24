// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { clerkFailure, createDesktopClerkClient, type ClerkCaller, type ClerkClient } from '../../integrations/clerk/ClerkClient';
import { BaseTool, type ToolResponse } from '../base';

export class ClerkWorker extends BaseTool {
  name = '';
  description = '';
  private clerkCaller?: ClerkCaller;

  constructor(private readonly client: () => ClerkClient = createDesktopClerkClient) {
    super();
  }

  bindClerkCaller(caller: ClerkCaller): void {
    this.clerkCaller = caller;
  }

  protected async _validatedCall(input: Record<string, unknown>): Promise<ToolResponse> {
    try {
      const metadata = this.state?.metadata;
      const signals: AbortSignal[] = [this.approvalSignal, metadata?.options?.abort?.signal].filter(Boolean);
      const result = await this.client().named(this.name.replace(/^clerk_/, ''), input, {
        ...this.clerkCaller,
        execution:      this.executionContext,
        conversationId: metadata?.threadId ?? this.clerkCaller?.conversationId,
        channel:        metadata?.wsChannel ?? this.clerkCaller?.channel,
        toolName:       this.name,
        deadlineAt:     this.deadlineAt ?? this.clerkCaller?.deadlineAt,
        signal:         signals.length ? AbortSignal.any(signals) : undefined,
        showApproval:   async(id, title) => this.sendChatMessage?.(title, 'tool_approval', {
          toolApproval: { approvalId: id, toolName: this.name, reason: title, command: title },
        }),
      });
      return { successBoolean: true, responseString: JSON.stringify(result ?? null), result };
    } catch (error) {
      const failure = clerkFailure(error);
      return {
        successBoolean: false,
        responseString: failure.message,
        status: failure.status,
        ...(failure.retryAfter ? { retryAfter: failure.retryAfter } : {}),
      };
    }
  }
}
