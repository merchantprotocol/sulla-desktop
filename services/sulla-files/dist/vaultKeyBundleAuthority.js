import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { FilesSafeDiagnosticError } from './startupDiagnostics.js';
const MAX_RESPONSE_BYTES = 1024 * 1024;
export class VaultFilesKeyBundleAuthority {
    config;
    origin;
    ca;
    constructor(config) {
        this.config = config;
        this.origin = new URL(config.baseUrl);
        if (!['https:', 'http:'].includes(this.origin.protocol) || this.origin.username || this.origin.password ||
            this.origin.search || this.origin.hash || this.origin.pathname !== '/') {
            throw new Error('Files Vault authority URL must be an HTTP(S) origin');
        }
        if (this.origin.protocol === 'http:' && !['127.0.0.1', 'localhost', '::1'].includes(this.origin.hostname)) {
            throw new Error('Files Vault authority requires TLS outside loopback');
        }
        if (Buffer.byteLength(config.serviceToken) < 32 || !config.serviceId) {
            throw new Error('Files Vault authority service identity is not configured');
        }
        if (this.origin.protocol === 'https:' && !config.caPath) {
            throw new Error('Files Vault authority CA is required for TLS pinning');
        }
    }
    unlockedPrincipal() {
        return this.request('principal-read', '/v1/desktop/files/principal');
    }
    custodyRecipient(context) {
        return this.request('custody-recipient', '/v1/desktop/files/custody-recipient', { context });
    }
    registerBundle(bundle) {
        return this.request('bundle-registration', '/v1/desktop/files/key-bundles', bundle);
    }
    authorizeDeviceRecovery(request) {
        return this.request('device-recovery', '/v1/desktop/files/device-recovery', request);
    }
    async request(operation, pathname, body) {
        const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
        let ca;
        try {
            ca = this.origin.protocol === 'https:' ? await (this.ca ??= readFile(this.config.caPath)) : undefined;
        }
        catch (error) {
            throw new FilesSafeDiagnosticError({ code: 'FILES_VAULT_AUTHORITY_CA_UNAVAILABLE', class: 'vault-authority', operation }, error);
        }
        const transport = this.origin.protocol === 'https:' ? https : http;
        return new Promise((resolve, reject) => {
            let settled = false;
            const resolveOnce = (value) => { if (!settled) {
                settled = true;
                resolve(value);
            } };
            const rejectOnce = (error) => { if (!settled) {
                settled = true;
                reject(error);
            } };
            const request = transport.request(new URL(pathname, this.origin), {
                method: payload ? 'POST' : 'GET',
                ca,
                headers: {
                    accept: 'application/json',
                    authorization: `Bearer ${this.config.serviceToken}`,
                    ...(payload
                        ? {
                            'content-length': String(payload.byteLength),
                            'content-type': 'application/json',
                        }
                        : {}),
                    'x-sulla-service-id': this.config.serviceId,
                },
                signal: AbortSignal.timeout(15_000),
            }, response => {
                const chunks = [];
                let size = 0;
                response.on('data', (chunk) => {
                    size += chunk.byteLength;
                    if (size > MAX_RESPONSE_BYTES) {
                        rejectOnce(new FilesSafeDiagnosticError({
                            code: 'FILES_VAULT_AUTHORITY_RESPONSE_TOO_LARGE', class: 'vault-authority', operation,
                        }));
                        response.destroy();
                        return;
                    }
                    chunks.push(chunk);
                });
                response.on('aborted', () => rejectOnce(new FilesSafeDiagnosticError({
                    code: 'FILES_VAULT_AUTHORITY_REQUEST_ABORTED', class: 'vault-authority', operation,
                })));
                response.on('error', error => rejectOnce(new FilesSafeDiagnosticError({
                    code: 'FILES_VAULT_AUTHORITY_RESPONSE_FAILED', class: 'vault-authority', operation,
                }, error)));
                response.on('end', () => {
                    const httpStatus = response.statusCode && response.statusCode >= 100 && response.statusCode <= 599
                        ? response.statusCode
                        : undefined;
                    if (!httpStatus || httpStatus < 200 || httpStatus >= 300) {
                        rejectOnce(new FilesSafeDiagnosticError({
                            code: 'FILES_VAULT_AUTHORITY_HTTP_FAILED', class: 'vault-authority', operation,
                            ...(httpStatus ? { httpStatus } : {}),
                        }));
                        return;
                    }
                    let parsed;
                    try {
                        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
                    }
                    catch {
                        rejectOnce(new FilesSafeDiagnosticError({
                            code: 'FILES_VAULT_AUTHORITY_RESPONSE_INVALID', class: 'vault-authority', operation,
                        }));
                        return;
                    }
                    resolveOnce(parsed);
                });
            });
            request.on('error', error => rejectOnce(error instanceof FilesSafeDiagnosticError
                ? error
                : new FilesSafeDiagnosticError({ code: 'FILES_VAULT_AUTHORITY_REQUEST_FAILED', class: 'vault-authority', operation }, error)));
            request.end(payload);
        });
    }
}
export function configuredVaultFilesKeyBundleAuthority(config) {
    const values = [config.vaultAuthorityUrl, config.vaultAuthorityId, config.vaultAuthorityToken];
    if (config.mode !== 'desktop' || values.every(value => !value))
        return undefined;
    if (values.some(value => !value))
        throw new Error('Files Vault authority configuration is incomplete');
    return new VaultFilesKeyBundleAuthority({
        baseUrl: config.vaultAuthorityUrl,
        serviceId: config.vaultAuthorityId,
        serviceToken: config.vaultAuthorityToken,
        caPath: config.vaultAuthorityCaPath,
    });
}
