const MAX_ACCOUNTS_RESPONSE_BYTES = 64 * 1024;
const MAX_IDENTITY_VALUE_LENGTH = 2_048;
const MAX_AUTHORIZATION_VALUES = 100;

import type { VaultConfig } from './config.js';

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
  input: { bearerToken: string; authorityId: string; organizationId: string },
): Promise<AccountsContext> {
  const accounts = config.accounts;
  if (!accounts) throw new AccountsIdentityError(403, 'Accounts integration is not configured');
  let response: Response;
  try {
    response = await fetch(`${ accounts.url }/v1/private/resolve-context`, {
      method:  'POST',
      headers: {
        'Content-Type':          'application/json',
        'X-Sulla-Service-Id':    accounts.serviceId,
        'X-Sulla-Service-Token': accounts.serviceToken,
      },
      body: JSON.stringify({ bearerToken: input.bearerToken, authorityId: input.authorityId,
        audience: accounts.audience, organizationId: input.organizationId, requiredRoles: accounts.requiredRoles }),
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
  const roles = authorizationValues(context.roles);
  const groups = authorizationValues(context.groups);
  if (!issuer || !subject || !roles || !groups || context.authorityId !== input.authorityId ||
      context.organizationId !== input.organizationId || context.audience !== accounts.audience ||
      accounts.requiredRoles.some(role => !roles.includes(role))) {
    throw new AccountsIdentityError(403, 'Accounts returned a mismatched identity context');
  }
  return { issuer, subject, roles, groups, authorityId: input.authorityId,
    organizationId: input.organizationId, audience: accounts.audience };
}
