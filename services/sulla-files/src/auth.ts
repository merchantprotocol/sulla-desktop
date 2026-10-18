import crypto from 'node:crypto';

import jwt from 'jsonwebtoken';

export interface CapabilityClaims { sub: string; org_id?: string; group_ids?: string[]; agent_id?: string; job_id?: string; thread_id?: string; device_id?: string; scopes: string[]; exp: number; aud: string; v: number }
export interface FilesIdentity { userId: string; deviceId: string; kind: 'capability' | 'server-session'; orgId?: string; groupIds?: string[]; agentId?: string; jobId?: string; threadId?: string }
const encode = (value:Buffer | string) => Buffer.from(value).toString('base64url');
export function deriveCapabilitySigningKey(secret:string | Buffer):Buffer { return crypto.createHmac('sha256', secret).update('sulla-tools-capability-v1').digest() }
export function issueCapabilityToken(input:{ sub: string; org_id?: string; group_ids?: string[]; agent_id?: string; job_id?: string; thread_id?: string; device_id?: string; scopes: string[] }, key:string | Buffer):string {
  const now = Math.floor(Date.now() / 1_000);
  const header = encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = encode(JSON.stringify({ ...input, v: 1, iss: 'sulla-files', aud: 'sulla-tools', iat: now, exp: now + 300, jti: crypto.randomUUID() }));
  const signature = crypto.createHmac('sha256', key).update(`${ header }.${ payload }`).digest('base64url');

  return `${ header }.${ payload }.${ signature }`;
}
export function verifyCapabilityToken(token:string | undefined, key:string | Buffer):CapabilityClaims {
  if (!token) throw new Error('Missing capability token');
  const [header, payload, signature, extra] = token.split('.');
  if (!header || !payload || !signature || extra) throw new Error('Malformed capability token');
  const expected = crypto.createHmac('sha256', key).update(`${ header }.${ payload }`).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) throw new Error('Invalid capability signature');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as CapabilityClaims;
  if (claims.v !== 1 || claims.aud !== 'sulla-tools' || claims.exp <= Math.floor(Date.now() / 1_000) || !claims.sub) throw new Error('Invalid capability claims');
  if (!claims.scopes?.some(scope => scope === '*' || scope === 'files/*')) throw new Error('Capability does not allow files');
  return claims;
}

export function verifyFilesIdentity(token:string | undefined, capabilityKey:string | Buffer, serverJwtSecret?:string):FilesIdentity {
  try {
    const claims = verifyCapabilityToken(token, capabilityKey);
    return { userId: claims.sub, deviceId: claims.device_id ?? '', kind: 'capability', orgId: claims.org_id, groupIds: claims.group_ids, agentId: claims.agent_id, jobId: claims.job_id, threadId: claims.thread_id };
  } catch (capabilityError) {
    if (!token || !serverJwtSecret) throw capabilityError;
    const payload = jwt.verify(token, serverJwtSecret, { algorithms: ['HS256'], audience: 'sulla-vault' });
    if (typeof payload === 'string' || typeof payload.sub !== 'string') throw new Error('Invalid server session');
    return { userId: payload.sub, deviceId: '', kind: 'server-session' };
  }
}
