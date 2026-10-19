import type { ProjectsIdentity } from './auth.js';
import type { ProjectsConfig } from './config.js';

function rejected(status: number, publicCode: string): Error {
  return Object.assign(new Error(publicCode), { status, publicCode });
}

/** Resolve every request against Accounts so membership removal and logout take effect immediately. */
export async function authenticateAccountsSession(
  config: ProjectsConfig, authorization: string | undefined, request: typeof fetch = fetch,
): Promise<ProjectsIdentity> {
  const token = authorization?.match(/^Bearer\s+([^\s]+)$/i)?.[1];
  if (!token || token.length > 4096) throw rejected(401, 'authentication_required');
  if (!config.accountsUrl || !config.accountsServiceToken) throw rejected(503, 'accounts_unavailable');
  let response: Response;
  try {
    response = await request(new URL('/v1/private/ui-sessions/resolve', config.accountsUrl), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: {
        'Content-Type': 'application/json', 'X-Sulla-Service-Id': 'projects',
        'X-Sulla-Service-Token': config.accountsServiceToken,
      },
      body: JSON.stringify({ token, audience: config.jwtAudience, requiredRoles: [] }),
    });
  } catch { throw rejected(503, 'accounts_unavailable'); }
  if (!response.ok) throw rejected(response.status === 401 ? 401 : response.status === 403 ? 403 : 503,
    response.status === 401 ? 'invalid_session' : response.status === 403 ? 'forbidden' : 'accounts_unavailable');
  const identity = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!identity || typeof identity.subject !== 'string' || !identity.subject.trim()
    || typeof identity.organizationId !== 'string' || !identity.organizationId.trim()
    || typeof identity.authorityId !== 'string' || !identity.authorityId.trim()
    || typeof identity.issuer !== 'string' || !identity.issuer.trim()
    || identity.audience !== config.jwtAudience || typeof identity.expiresAt !== 'string'
    || !Number.isFinite(Date.parse(identity.expiresAt)) || Date.parse(identity.expiresAt) <= Date.now()
    || !Array.isArray(identity.roles) || identity.roles.some(role => typeof role !== 'string')) {
    throw rejected(401, 'invalid_session');
  }
  const roles = identity.roles as string[];
  const role = roles.some(role => role === 'owner' || role === 'admin') ? 'admin'
    : roles.includes('editor') ? 'editor' : 'viewer';
  return { subject: identity.subject, tenantId: identity.organizationId, actor: identity.subject, source: 'ipc', local: false, role };
}
