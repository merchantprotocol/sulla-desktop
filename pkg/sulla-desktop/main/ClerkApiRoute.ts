// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { clerkFailure, ClerkError, type ClerkCaller, type ClerkClient } from '@pkg/agent/integrations/clerk/ClerkClient';
import { ClerkRawRequestEnvelope } from '@pkg/agent/integrations/clerk/ClerkRawRequestEnvelope';
import { ToolApprovalGate } from '@pkg/agent/tools/ToolApprovalGate';
import { CLERK_ACCOUNT, clerkEndpoints } from '@pkg/agent/integrations/clerk/ClerkEndpoints';

import type { Request, Response } from 'express';

export class ClerkApiRoute {
  constructor(
    private readonly client: () => ClerkClient,
    private readonly caller: (request: Request, name: string, signal: AbortSignal) => Promise<ClerkCaller>,
    private readonly approvals: ToolApprovalGate,
  ) {}

  async handle(request: Request, response: Response, endpoint?: string): Promise<void> {
    const disconnect = new AbortController();
    const cancel = () => { if (!response.writableEnded) disconnect.abort(); };
    response.once('close', cancel);
    try {
      if (request.params.accountId !== CLERK_ACCOUNT) throw new ClerkError(404, 'Clerk uses the default account.');
      const name = endpoint?.replace(/^clerk_/, '') ?? 'raw_request';
      const caller = await this.caller(request, `clerk_${ name }`, disconnect.signal);
      if (name !== 'get_config' && name !== 'raw_request' && !Object.hasOwn(clerkEndpoints, name)) throw new ClerkError(404, 'Unknown Clerk tool.');
      const input = request.body ?? {};
      if (name === 'raw_request') {
        const refusal = new ClerkRawRequestEnvelope().refusal(input, endpoint === undefined ? 'proxy' : 'tool');
        if (refusal) throw new ClerkError(400, refusal);
      }
      const approval = await this.approvals.check({
        category: 'clerk', name: `clerk_${ name }`, conversationId: caller.conversationId, channel: caller.channel, signal: caller.signal,
      });
      if (approval && approval.answer.status !== 'approved') throw new ClerkError(403, 'Clerk tool approval was not granted. Nothing was sent.');
      caller.signal?.throwIfAborted();
      const clerk = this.client();
      if (endpoint !== undefined) {
        // Raw requests have one flat envelope shared with /v1/proxy; never
        // unwrap `params` before the ClerkClient rejects unsupported fields.
        const args = name === 'raw_request' ? input : input.params ?? input;
        const result = await clerk.named(name, args, caller);
        response.json({ success: true, result });
      } else {
        const result = await clerk.raw(input, caller);
        if (result.status === 'approval_pending') {
          response.json({ success: true, result });
        } else {
          response.status(result.status === 204 ? 200 : result.status).json({ success: true, status: result.status, result: result.body ?? null });
        }
      }
    } catch (error) {
      const failure = clerkFailure(error);
      if (!disconnect.signal.aborted) {
        if (failure.retryAfter) response.setHeader('Retry-After', failure.retryAfter);
        response.status(failure.status).json({ success: false, error: failure.message });
      }
    } finally {
      response.off('close', cancel);
    }
  }
}
