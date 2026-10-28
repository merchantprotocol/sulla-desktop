// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

const MAX_ACCOUNTS_RESPONSE_BYTES = 64 * 1024;
const MAX_IDENTITY_VALUE_LENGTH = 2_048;
const MAX_AUTHORIZATION_VALUES = 100;

import type { VaultConfig } from './config.js';

// Accounts organization roles are ranked: an owner or admin is also a member.
// Required roles outside this ladder must be held exactly.
const ROLE_RANK = ['viewer', 'member', 'editor', 'admin', 'owner'];

function hasRole(held: string[], required: string): boolean {
  const needed = ROLE_RANK.indexOf(required);
  if (needed < 0) return held.includes(required);
  return held.some(role => ROLE_RANK.indexOf(role) >= needed);
}

export interface AccountsContext {
  issuer:         string;
  subject:        string;
  authorityId:    string;
  organizationId: string;
  roles:          string[];
  groups:         string[];
  audience:       string;
}

export class AccountsIdentityError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message);
    this.name = 'AccountsIdentityError';
  }
}

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_ACCOUNTS_RESPONSE_BYTES || !response.body) {
    throw new AccountsIdentityError(403, 'Accounts returned an invalid response');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_ACCOUNTS_RESPONSE_BYTES) {
      await reader.cancel();
      throw new AccountsIdentityError(403, 'Accounts response is too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
    return value as Record<string, unknown>;
  } catch {
    throw new AccountsIdentityError(403, 'Accounts returned an invalid response');
  }
}

function identityString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_IDENTITY_VALUE_LENGTH && value.trim() === value
    ? value : null;
}

function authorizationValues(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_AUTHORIZATION_VALUES ||
      value.some(item => typeof item !== 'string' || !item || item.length > 120 || item.trim() !== item)) return null;
  return [...new Set(value as string[])];
}

export async function resolveAccountsContext(
  config: VaultConfig,
  input: { bearerToken: string },
): Promise<AccountsContext> {
  const accounts = config.accounts;
  if (!accounts) throw new AccountsIdentityError(403, 'Accounts integration is not configured');
  let response: Response;
  try {
    response = await fetch(`${ accounts.url }/v1/private/ui-sessions/resolve`, {
      method:  'POST',
      headers: {
        'Content-Type':          'application/json',
        'X-Sulla-Service-Id':    accounts.serviceId,
        'X-Sulla-Service-Token': accounts.serviceToken,
      },
      body: JSON.stringify({ token: input.bearerToken, audience: accounts.audience, requiredRoles: accounts.requiredRoles }),
      redirect: 'error',
      signal:   AbortSignal.timeout(5_000),
    });
  } catch {
    throw new AccountsIdentityError(403, 'Accounts identity could not be verified');
  }
  const context = await boundedJson(response);
  if (!response.ok) throw new AccountsIdentityError(response.status === 401 ? 401 : 403, 'Accounts denied this identity');
  const issuer = identityString(context.issuer);
  const subject = identityString(context.subject);
  const authorityId = identityString(context.authorityId);
  const organizationId = identityString(context.organizationId);
  const roles = authorizationValues(context.roles);
  const groups = authorizationValues(context.groups);
  const expiresAt = typeof context.expiresAt === 'string' ? Date.parse(context.expiresAt) : Number.NaN;
  if (!issuer || !subject || !authorityId || !organizationId || !roles || !groups ||
      context.audience !== accounts.audience || !Number.isFinite(expiresAt) || expiresAt <= Date.now() ||
      accounts.requiredRoles.some(role => !hasRole(roles, role))) {
    throw new AccountsIdentityError(403, 'Accounts returned a mismatched identity context');
  }
  return { issuer, subject, roles, groups, authorityId,
    organizationId, audience: accounts.audience };
}
