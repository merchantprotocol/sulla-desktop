// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License. See LICENSE.

import { timingSafeEqual } from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';

import type { AccountsSession } from './clients/accounts.js';
import type { UpstreamClients } from './clients/index.js';
import { UpstreamError } from './clients/upstream.js';

declare global {
  namespace Express {
    interface Request { consoleSession?: AccountsSession }
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function cookie(request: Request, name: string): string | undefined {
  for (const part of (request.header('cookie') ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
}

function equal(left?: string, right?: string): boolean {
  if (!left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function requireWebSession(clients: UpstreamClients) {
  return async(request: Request, response: Response, next: NextFunction): Promise<void> => {
    try {
      if (!SAFE_METHODS.has(request.method) && !equal(request.header('x-sulla-csrf'), cookie(request, 'sulla-console-csrf'))) {
        response.status(403).json({ error: 'invalid_csrf' });
        return;
      }
      request.consoleSession = await clients.accounts.session(request);
      next();
    } catch (error) {
      if (error instanceof UpstreamError && (error.status === 401 || error.status === 403)) {
        response.status(401).json({ error: 'authentication_required' });
        return;
      }
      next(error);
    }
  };
}
