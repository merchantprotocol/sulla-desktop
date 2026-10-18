import crypto from 'node:crypto';

import jwt from 'jsonwebtoken';

export interface ProjectsIdentity {
  subject: string;
  tenantId: string;
  actor: string;
  source: 'tool' | 'ipc' | 'heartbeat' | 'routine' | 'system';
  local: boolean;
  role: 'viewer' | 'editor' | 'admin';
}

const LOCAL_SOURCES = new Set<ProjectsIdentity['source']>(['tool', 'ipc', 'heartbeat', 'routine', 'system']);

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function authenticateProjectsRequest(input: {
  authorization?: string;
  localToken?: string;
  humanToken?: string;
  mode: 'desktop' | 'server';
  jwtSecret?: string;
  jwtPublicKey?: string;
  jwtIssuer?: string;
  jwtAudience: string;
  localSubject: string;
  localTenant: string;
  localActor?: string;
  localSource?: ProjectsIdentity['source'];
}): ProjectsIdentity {
  const token = input.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw Object.assign(new Error('Authentication required'), { status: 401 });
  if (input.mode === 'desktop') {
    if (input.humanToken && sameSecret(token, input.humanToken)) {
      return { subject: input.localSubject, tenantId: input.localTenant, actor: 'human', source: 'ipc', local: true, role: 'admin' };
    }
    if (!input.localToken || !sameSecret(token, input.localToken)) {
      throw Object.assign(new Error('Invalid local Projects pairing'), { status: 401 });
    }
    return {
      subject: input.localSubject,
      tenantId: input.localTenant,
      actor: input.localActor?.trim() && input.localActor.trim() !== 'human' ? input.localActor.trim() : 'sulla',
      source: input.localSource === 'ipc' ? 'system' : input.localSource ?? 'system',
      local: true,
      role: 'editor',
    };
  }
  const verificationKey = input.jwtPublicKey || input.jwtSecret;
  if (!verificationKey || !input.jwtIssuer) throw Object.assign(new Error('Projects server JWT verification is not configured'), { status: 503 });
  let payload: string | jwt.JwtPayload;
  try {
    payload = jwt.verify(token, verificationKey, {
      algorithms: input.jwtPublicKey ? ['RS256', 'ES256'] : ['HS256'],
      audience: input.jwtAudience,
      issuer: input.jwtIssuer,
      clockTolerance: 5,
    });
  } catch {
    throw Object.assign(new Error('Invalid Projects session'), { status: 401 });
  }
  if (typeof payload === 'string' || typeof payload.sub !== 'string' || typeof payload.exp !== 'number') {
    throw Object.assign(new Error('Invalid Projects session'), { status: 401 });
  }
  const tenant = typeof payload.org_id === 'string' && payload.org_id.trim()
    ? payload.org_id.trim()
    : typeof payload.tenant_id === 'string' && payload.tenant_id.trim() ? payload.tenant_id.trim() : '';
  if (!tenant) throw Object.assign(new Error('Projects tenant claim is required'), { status: 401 });
  const actor = typeof payload.agent_id === 'string' && payload.agent_id ? payload.agent_id : payload.sub;
  const source = LOCAL_SOURCES.has(payload.source as ProjectsIdentity['source'])
    ? payload.source as ProjectsIdentity['source'] : 'system';
  const claimedRole = payload.projects_role ?? payload.role;
  const role = claimedRole === 'admin' || claimedRole === 'editor' || claimedRole === 'viewer' ? claimedRole : 'viewer';
  return { subject: payload.sub, tenantId: tenant, actor, source, local: false, role };
}
