import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';

import type { Config } from './config.js';
import type { FilesKeyBundleAuthority, StoredFilesKeyBundle } from './keyBundleRecovery.js';
import type {
  Base64,
  FilesKeyBundleContext,
  FilesKeyBundleEnvelope,
} from '@sulla/vault-crypto';

const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface VaultFilesAuthorityClientConfig {
  baseUrl:      string;
  serviceId:    string;
  serviceToken: string;
  caPath?:      string;
}

export class VaultFilesKeyBundleAuthority implements FilesKeyBundleAuthority {
  private readonly origin: URL;
  private ca?:             Promise<Buffer>;

  constructor(private readonly config:VaultFilesAuthorityClientConfig) {
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

  unlockedPrincipal():Promise<{ principalId: string; generation: number }> {
    return this.request('/v1/desktop/files/principal');
  }

  custodyRecipient(context:FilesKeyBundleContext):Promise<{ keyId: string; publicKey: Base64 }> {
    return this.request('/v1/desktop/files/custody-recipient', { context });
  }

  registerBundle(bundle:StoredFilesKeyBundle):Promise<void> {
    return this.request('/v1/desktop/files/key-bundles', bundle);
  }

  authorizeDeviceRecovery(request:{ context: FilesKeyBundleContext; devicePublicKey: Base64 }):Promise<FilesKeyBundleEnvelope> {
    return this.request('/v1/desktop/files/device-recovery', request);
  }

  private async request<T>(pathname:string, body?:unknown):Promise<T> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const ca = this.origin.protocol === 'https:' ? await (this.ca ??= readFile(this.config.caPath!)) : undefined;
    const transport = this.origin.protocol === 'https:' ? https : http;
    return new Promise<T>((resolve, reject) => {
      const request = transport.request(new URL(pathname, this.origin), {
        method:  payload ? 'POST' : 'GET',
        ca,
        headers: {
          accept:                 'application/json',
          authorization:          `Bearer ${ this.config.serviceToken }`,
          ...(payload
            ? {
              'content-length': String(payload.byteLength),
              'content-type':   'application/json',
            }
            : {}),
          'x-sulla-service-id': this.config.serviceId,
        },
        signal: AbortSignal.timeout(15_000),
      }, response => {
        const chunks:Buffer[] = [];
        let size = 0;
        response.on('data', (chunk:Buffer) => {
          size += chunk.byteLength;
          if (size > MAX_RESPONSE_BYTES) {
            response.destroy(new Error('Vault authority response exceeded the limit'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          let parsed:unknown;
          try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch {
            reject(new Error('Vault authority returned invalid JSON'));
            return;
          }
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            const message = parsed && typeof parsed === 'object' && typeof (parsed as { message?: unknown }).message === 'string'
              ? (parsed as { message: string }).message
              : `Vault authority request failed (${ response.statusCode ?? 0 })`;
            reject(new Error(message));
            return;
          }
          resolve(parsed as T);
        });
      });
      request.on('error', reject);
      request.end(payload);
    });
  }
}

export function configuredVaultFilesKeyBundleAuthority(
  config:Pick<Config, 'mode' | 'vaultAuthorityUrl' | 'vaultAuthorityId' | 'vaultAuthorityToken' | 'vaultAuthorityCaPath'>,
):VaultFilesKeyBundleAuthority | undefined {
  const values = [config.vaultAuthorityUrl, config.vaultAuthorityId, config.vaultAuthorityToken];
  if (config.mode !== 'desktop' || values.every(value => !value)) return undefined;
  if (values.some(value => !value)) throw new Error('Files Vault authority configuration is incomplete');
  return new VaultFilesKeyBundleAuthority({
    baseUrl:      config.vaultAuthorityUrl!,
    serviceId:    config.vaultAuthorityId!,
    serviceToken: config.vaultAuthorityToken!,
    caPath:       config.vaultAuthorityCaPath,
  });
}
