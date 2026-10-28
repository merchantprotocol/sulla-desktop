// SPDX-License-Identifier: GPL-2.0-or-later
function denied(status, code) { return Object.assign(new Error(code), { status }); }
export async function resolveFilesUiSession(config, token, request = fetch) {
    if (!token || token.length > 1024)
        throw denied(401, 'invalid_session');
    if (!config.accounts)
        throw denied(503, 'accounts_unavailable');
    let response;
    try {
        response = await request(new URL('/v1/private/ui-sessions/resolve', config.accounts.url), {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5_000),
            headers: { 'Content-Type': 'application/json', 'X-Sulla-Service-Id': 'files', 'X-Sulla-Service-Token': config.accounts.serviceToken },
            body: JSON.stringify({ token, audience: config.accounts.audience, requiredRoles: [] }),
        });
    }
    catch {
        throw denied(503, 'accounts_unavailable');
    }
    if (!response.ok)
        throw denied(response.status === 401 ? 401 : response.status === 403 ? 403 : 503, response.status === 401 ? 'invalid_session' : response.status === 403 ? 'forbidden' : 'accounts_unavailable');
    const value = await response.text();
    if (Buffer.byteLength(value) > 64 * 1024)
        throw denied(401, 'invalid_session');
    let identity;
    try {
        identity = JSON.parse(value);
    }
    catch {
        throw denied(401, 'invalid_session');
    }
    const strings = ['issuer', 'subject', 'authorityId', 'organizationId'];
    if (!identity || strings.some(key => typeof identity[key] !== 'string' || !identity[key].trim()) ||
        identity.audience !== config.accounts.audience || typeof identity.expiresAt !== 'string' ||
        !Number.isFinite(Date.parse(identity.expiresAt)) || Date.parse(identity.expiresAt) <= Date.now() ||
        !Array.isArray(identity.roles) || identity.roles.some(role => typeof role !== 'string') ||
        !Array.isArray(identity.groups) || identity.groups.some(group => typeof group !== 'string'))
        throw denied(401, 'invalid_session');
    return identity;
}
