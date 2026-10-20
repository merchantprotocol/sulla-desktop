import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
const encode = (value) => Buffer.from(value).toString('base64url');
export function deriveCapabilitySigningKey(secret) { return crypto.createHmac('sha256', secret).update('sulla-tools-capability-v1').digest(); }
export function issueCapabilityToken(input, key) {
    const now = Math.floor(Date.now() / 1_000);
    const header = encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = encode(JSON.stringify({ ...input, v: 1, iss: 'sulla-files', aud: 'sulla-tools', iat: now, exp: now + 300, jti: crypto.randomUUID() }));
    const signature = crypto.createHmac('sha256', key).update(`${header}.${payload}`).digest('base64url');
    return `${header}.${payload}.${signature}`;
}
export function verifyCapabilityToken(token, key) {
    if (!token)
        throw new Error('Missing capability token');
    const [header, payload, signature, extra] = token.split('.');
    if (!header || !payload || !signature || extra)
        throw new Error('Malformed capability token');
    const expected = crypto.createHmac('sha256', key).update(`${header}.${payload}`).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected))
        throw new Error('Invalid capability signature');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (claims.v !== 1 || claims.aud !== 'sulla-tools' || claims.exp <= Math.floor(Date.now() / 1_000) || !claims.sub)
        throw new Error('Invalid capability claims');
    if (!claims.scopes?.some(scope => scope === '*' || scope === 'files/*' || scope === 'files/fuse'))
        throw new Error('Capability does not allow files');
    return claims;
}
export function verifyFilesIdentity(token, capabilityKey, serverJwtSecret) {
    try {
        const claims = verifyCapabilityToken(token, capabilityKey);
        return { userId: claims.sub, deviceId: claims.device_id ?? '', kind: 'capability', scopes: claims.scopes, orgId: claims.org_id, groupIds: claims.group_ids, agentId: claims.agent_id, jobId: claims.job_id, threadId: claims.thread_id, collectionId: claims.collection_id };
    }
    catch (capabilityError) {
        if (!token || !serverJwtSecret)
            throw capabilityError;
        const payload = jwt.verify(token, serverJwtSecret, { algorithms: ['HS256'], audience: 'sulla-vault' });
        if (typeof payload === 'string' || typeof payload.sub !== 'string')
            throw new Error('Invalid server session');
        return { userId: payload.sub, deviceId: '', kind: 'server-session' };
    }
}
