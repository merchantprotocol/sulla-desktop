// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { clerkFailure, ClerkError, type ClerkCaller, type ClerkClient } from '@pkg/agent/integrations/clerk/ClerkClient';
import { CLERK_ACCOUNT } from '@pkg/agent/integrations/clerk/ClerkEndpoints';

import type { Request, Response } from 'express';

export class ClerkApiRoute {
  constructor(
    private readonly client: () => ClerkClient,
    private readonly caller: (request: Request, name: string, signal: AbortSignal) => Promise<ClerkCaller>,
  ) {}

  async handle(request: Request, response: Response, endpoint?: string): Promise<void> {
    const disconnect = new AbortController();
    const cancel = () => { if (!response.writableEnded) disconnect.abort(); };
    response.once('close', cancel);
    try {
      if (request.params.accountId !== CLERK_ACCOUNT) throw new ClerkError(404, 'Clerk uses the default account.');
      const name = endpoint?.replace(/^clerk_/, '') ?? 'raw_request';
      const caller = await this.caller(request, `clerk_${ name }`, disconnect.signal);
      const clerk = this.client();
      const input = request.body ?? {};
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
