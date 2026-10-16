import crypto from 'node:crypto';

export interface CapabilityTokenClaims {
  v:                      1;
  iss:                    string;
  aud:                    'sulla-tools';
  sub:                    string;
  org_id?:                string;
  agent_id?:              string;
  pod_id?:                string;
  thread_id?:             string;
  job_id?:                string;
  workflow_execution_id?: string;
  device_id?:             string;
  scopes:                 string[];
  iat:                    number;
  exp:                    number;
  jti:                    string;
}

export interface CapabilityTokenInput extends Omit<CapabilityTokenClaims, 'v' | 'iss' | 'aud' | 'iat' | 'exp' | 'jti'> {
  expiresInSeconds?: number;
  jti?:              string;
}

export interface CapabilityRevocationStore {
  isRevoked(jti: string): Promise<boolean>;
  revoke(jti: string, expiresAt: number): Promise<void>;
}

export class CapabilityTokenError extends Error {
  constructor(public readonly code: 'missing' | 'malformed' | 'invalid' | 'expired' | 'audience' | 'revoked' | 'scope', message: string) {
    super(message);
    this.name = 'CapabilityTokenError';
  }
}

const encode = (value: Buffer | string) => Buffer.from(value).toString('base64url');
const decodeJson = (value: string) => JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));

export function deriveCapabilitySigningKey(installationSecret: string | Buffer): Buffer {
  return crypto.createHmac('sha256', installationSecret).update('sulla-tools-capability-v1').digest();
}

export function issueCapabilityToken(input: CapabilityTokenInput, signingKey: string | Buffer, issuer = 'sulla-desktop'): string {
  if (!signingKey || Buffer.byteLength(signingKey) < 32) throw new Error('Capability signing key must be at least 32 bytes');
  const now = Math.floor(Date.now() / 1000);
  const claims: CapabilityTokenClaims = {
    ...input,
    v:      1,
    iss:    issuer,
    aud:    'sulla-tools',
    iat:    now,
    exp:    now + Math.max(1, Math.min(input.expiresInSeconds ?? 900, 3600)),
    jti:    input.jti ?? crypto.randomUUID(),
    scopes: [...new Set(input.scopes)],
  };
  delete (claims as any).expiresInSeconds;
  const header = encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = encode(JSON.stringify(claims));
  const signature = crypto.createHmac('sha256', signingKey).update(`${ header }.${ payload }`).digest('base64url');

  return `${ header }.${ payload }.${ signature }`;
}

export function scopeAllows(scopes: string[], category: string, tool: string): boolean {
  const unprefixed = tool.startsWith(`${ category }_`) ? tool.slice(category.length + 1) : tool;
  const candidates = new Set([tool, unprefixed, `${ category }/${ tool }`, `${ category }/${ unprefixed }`, `${ category }/*`, '*']);

  return scopes.some(scope => candidates.has(scope));
}

export async function verifyCapabilityToken(
  token: string | undefined,
  signingKey: string | Buffer,
  options: { category?: string; tool?: string; revocations?: CapabilityRevocationStore; now?: number } = {},
): Promise<CapabilityTokenClaims> {
  if (!token) throw new CapabilityTokenError('missing', 'Missing capability token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new CapabilityTokenError('malformed', 'Malformed capability token');
  const [header, payload, signature] = parts;
  const expected = crypto.createHmac('sha256', signingKey).update(`${ header }.${ payload }`).digest();
  let provided: Buffer;
  try { provided = Buffer.from(signature, 'base64url') } catch { throw new CapabilityTokenError('malformed', 'Malformed capability signature') }
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    throw new CapabilityTokenError('invalid', 'Invalid capability signature');
  }
  let claims: CapabilityTokenClaims;
  try {
    const parsedHeader = decodeJson(header);
    if (parsedHeader.alg !== 'HS256' || parsedHeader.typ !== 'JWT') throw new Error('Unsupported capability header');
    claims = decodeJson(payload);
  } catch { throw new CapabilityTokenError('malformed', 'Malformed capability token') }
  if (claims.v !== 1 || claims.aud !== 'sulla-tools') throw new CapabilityTokenError('audience', 'Capability audience is not sulla-tools');
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(claims.exp) || claims.exp <= now) throw new CapabilityTokenError('expired', 'Capability token has expired');
  if (!claims.iss || !claims.sub || !claims.jti || !Number.isFinite(claims.iat) || !Array.isArray(claims.scopes) || !claims.scopes.every(scope => typeof scope === 'string')) {
    throw new CapabilityTokenError('malformed', 'Capability token is missing required claims');
  }
  if (options.revocations && await options.revocations.isRevoked(claims.jti)) throw new CapabilityTokenError('revoked', 'Capability token has been revoked');
  if (options.category && options.tool && !scopeAllows(claims.scopes, options.category, options.tool)) {
    throw new CapabilityTokenError('scope', `Capability does not allow ${ options.category }/${ options.tool }`);
  }

  return claims;
}
