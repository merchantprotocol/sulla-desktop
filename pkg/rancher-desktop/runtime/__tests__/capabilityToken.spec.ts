import crypto from 'node:crypto';

import { issueCapabilityToken, verifyCapabilityToken } from '../capabilityToken';

const key = Buffer.alloc(32, 7);

describe('tool capability tokens', () => {
  test('fails closed for scope, expiry, audience tampering, and revocation', async() => {
    const token = issueCapabilityToken({ sub: 'agent-1', scopes: ['project/*'], expiresInSeconds: 30, jti: 'one' }, key);
    await expect(verifyCapabilityToken(token, key, { category: 'project', tool: 'list_project_items' })).resolves.toMatchObject({ sub: 'agent-1' });
    await expect(verifyCapabilityToken(token, key, { category: 'pg', tool: 'pg_query' })).rejects.toMatchObject({ code: 'scope' });
    await expect(verifyCapabilityToken(token, key, { now: Math.floor(Date.now() / 1000) + 31 })).rejects.toMatchObject({ code: 'expired' });
    await expect(verifyCapabilityToken(token, key, { revocations: { isRevoked: () => Promise.resolve(true), revoke: () => Promise.resolve() } })).rejects.toMatchObject({ code: 'revoked' });

    const [header, payload, signature] = token.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    claims.aud = 'somewhere-else';
    const wrongPayload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const wrongSignature = crypto.createHmac('sha256', key).update(`${ header }.${ wrongPayload }`).digest('base64url');
    const wrongAudience = `${ header }.${ wrongPayload }.${ wrongSignature }`;
    await expect(verifyCapabilityToken(wrongAudience, key)).rejects.toMatchObject({ code: 'audience' });
  });
});
