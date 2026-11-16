// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { timingSafeEqual } from 'node:crypto';

import type { Request, Response } from 'express';

import type { VaultConfig } from '../config.js';

/** A 400 whose message is returned as `{ error: message }` by VaultErrorHandler. */
export class VaultHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

/**
 * Request parsing shared by every vault route group: required body fields, the caller's service
 * identity, and the human session cookie. Members are arrow properties so route groups can
 * destructure them.
 */
export class VaultRequestInput {
  constructor(private readonly config: VaultConfig) {}

  readonly requiredString = (value: unknown, name: string): string => {
    if (typeof value !== 'string' || !value) {
      throw new VaultHttpError(400, `${ name } is required`);
    }
    return value;
  };

  readonly requiredObject = (value: unknown, name: string): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new VaultHttpError(400, `${ name } is required`);
    }
    return value as Record<string, unknown>;
  };

  readonly safeTokenEqual = (actual: string | undefined, expected: string | undefined): boolean => {
    if (!actual || !expected) return false;
    const left = Buffer.from(actual);
    const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right);
  };

  readonly serviceIdentity = (request: Request): { serviceId: string; token?: string } => ({
    serviceId: request.header('x-sulla-service-id') ?? '',
    token: request.header('authorization')?.replace(/^Bearer\s+/i, ''),
  });

  readonly humanCookie = (request: Request): string | undefined =>
    request.header('cookie')?.split(';').map(value => value.trim()).find(value => value.startsWith('sulla_vault_human='))?.slice('sulla_vault_human='.length);

  readonly setHumanCookie = (response: Response, sessionId: string, expiresAt: number): void => {
    const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    const secure = this.config.humanUiOrigin?.startsWith('https:') ? '; Secure' : '';
    response.setHeader('Set-Cookie', `sulla_vault_human=${ sessionId }; HttpOnly; SameSite=Strict; Path=/v1/human; Max-Age=${ maxAge }${ secure }`);
  };
}
