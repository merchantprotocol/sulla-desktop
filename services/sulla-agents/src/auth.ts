// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'node:crypto';

import { config } from './config.js';

import type { NextFunction, Request, Response } from 'express';

export interface RequestIdentity { roles: string[] }
export interface AuthenticatedRequest extends Request { identity?: RequestIdentity }
function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

export function authenticateRequest(request: AuthenticatedRequest, response: Response, next: NextFunction): void {
  const token = request.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] ?? '';
  if (!equalSecret(token, config.localToken)) {
    response.status(401).json({ error: 'authentication_required' }); return;
  }
  request.identity = { roles: ['owner'] };
  next();
}

export function requireEditor(request: AuthenticatedRequest, response: Response, next: NextFunction): void {
  if (!request.identity?.roles.some(role => ['owner', 'admin', 'editor'].includes(role))) {
    response.status(403).json({ error: 'editor_role_required' }); return;
  }
  next();
}
