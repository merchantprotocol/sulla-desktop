// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash, createPublicKey, verify } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { Integration } from './types';

export type IntegrationAuthType = 'none' | 'apiKey' | 'oauth2' | 'bearer' | 'mcp';

export interface IntegrationPackageManifest {
  apiVersion:  'sulla/v1';
  kind:        'integration';
  id:          string;
  version:     string;
  sullaApi:    string;
  permissions: string[];
  entry:       string;
  integrity:   string;
  signature:   { algorithm: 'ed25519'; keyId: string; value: string };
  auth: {
    type:    IntegrationAuthType;
    scopes?: string[];
  };
  baseUrls:  string[];
  tools?: Array<{ name: string; endpoint: string }>;
  proxyPaths?: Array<{ method: string; path: string }>;
}

export interface IntegrationPackage {
  manifest: IntegrationPackageManifest;
  /** Package files keyed by normalized, relative POSIX path. */
  files: Record<string, string | Buffer>;
  /** First-party packages are bundled with the signed app and pre-granted. */
  firstParty?: boolean;
  /** Runtime catalog entry exported by the declared entry module. */
  integration: Integration;
}

export interface IntegrationGrantStore {
  isGranted(id: string, version: string, permissions: readonly string[]): boolean | Promise<boolean>;
}

export interface TrustedPublisherKeys { keys: Array<{ keyId: string; publicKey: string; enabled?: boolean }> }

export function resolveTrustedPublisherKeysPath(): string {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return resourcesPath
    ? path.join(resourcesPath, 'resources', 'trusted-integration-publishers.json')
    : path.resolve(process.cwd(), 'resources', 'trusted-integration-publishers.json');
}

export class Ed25519SignatureVerifier implements IntegrationSignatureVerifier {
  constructor(private readonly trusted: TrustedPublisherKeys) {}
  verify(input: { integrity: string; signature: IntegrationPackageManifest['signature'] }): boolean {
    if (input.signature.algorithm !== 'ed25519') return false;
    const key = this.trusted.keys.find(item => item.keyId === input.signature.keyId && item.enabled !== false);
    if (!key) return false;
    try {
      return verify(null, Buffer.from(input.integrity, 'utf8'), createPublicKey(key.publicKey), Buffer.from(input.signature.value, 'base64'));
    } catch { return false }
  }
}

export function trustedPublisherVerifier(filePath: string): Ed25519SignatureVerifier {
  let parsed: TrustedPublisherKeys;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as TrustedPublisherKeys;
  } catch {
    throw new Error("no trusted publisher keys; third-party integrations can't be installed yet");
  }
  if (!parsed || !Array.isArray(parsed.keys) || parsed.keys.filter(key => key.enabled !== false).length === 0) {
    throw new Error("no trusted publisher keys; third-party integrations can't be installed yet");
  }
  return new Ed25519SignatureVerifier(parsed);
}

export interface IntegrationProxy {
  request(input: { integrationId: string; method: string; path: string; body?: unknown }): Promise<unknown>;
}

export interface IntegrationSignatureVerifier {
  verify(input: { id: string; version: string; integrity: string; signature: IntegrationPackageManifest['signature'] }): boolean | Promise<boolean>;
}

/** The only capability exposed to integration entry code. Vault access is intentionally absent. */
export interface IntegrationRuntimeApi {
  proxy(input: { method: string; path: string; body?: unknown }): Promise<unknown>;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${ value.map(stableJson).join(',') }]`;
  if (value && typeof value === 'object') {
    return `{${ Object.keys(value as object).sort().map(key => `${ JSON.stringify(key) }:${ stableJson((value as Record<string, unknown>)[key]) }`).join(',') }}`;
  }
  return JSON.stringify(value);
}

export function integrationPackageHash(pkg: Pick<IntegrationPackage, 'manifest' | 'files'>): string {
  const { integrity: _integrity, signature: _signature, ...manifest } = pkg.manifest;
  const files = Object.fromEntries(Object.entries(pkg.files).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => [
    name,
    createHash('sha256').update(value).digest('hex'),
  ]));
  return `sha256:${ createHash('sha256').update(stableJson({ manifest, files })).digest('hex') }`;
}

function validatePath(value: string, label: string): void {
  if (!value.startsWith('/') || value.includes('..') || value.includes('\\')) throw new Error(`${ label } must be an absolute URL path without traversal`);
}

export function validateIntegrationPackage(pkg: IntegrationPackage): void {
  const { manifest } = pkg;
  if (manifest.apiVersion !== 'sulla/v1' || manifest.kind !== 'integration') throw new Error('Unsupported integration package envelope');
  if (!/^[a-z][a-z0-9_-]*$/.test(manifest.id)) throw new Error('Integration package id must be a lowercase slug');
  if (!/^\d+\.\d+\.\d+/.test(manifest.version)) throw new Error('Integration package version must be semver');
  if (!manifest.sullaApi || !Array.isArray(manifest.permissions)) throw new Error('Integration package must declare sullaApi and permissions');
  if (!manifest.entry || !Object.hasOwn(pkg.files, manifest.entry)) throw new Error(`Integration package entry not found: ${ manifest.entry }`);
  if (pkg.integration.id !== manifest.id) throw new Error(`Integration entry id "${ pkg.integration.id }" does not match package id "${ manifest.id }"`);
  for (const url of manifest.baseUrls) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') throw new Error(`Integration base URL must use HTTPS: ${ url }`);
  }
  for (const route of manifest.proxyPaths ?? []) validatePath(route.path, 'proxyPaths.path');
  for (const tool of manifest.tools ?? []) validatePath(tool.endpoint, 'tools.endpoint');
  const actual = integrationPackageHash(pkg);
  if (actual !== manifest.integrity) throw new Error(`Integration package integrity mismatch: expected ${ manifest.integrity }, got ${ actual }`);
}

export class IntegrationPackageLoader {
  constructor(
    private readonly grants: IntegrationGrantStore,
    private readonly proxy: IntegrationProxy,
    private readonly signatures: IntegrationSignatureVerifier,
  ) {}

  /** Verify immutable package bytes before persistence. Grants are checked only when code is loaded. */
  async verifyPackage(pkg: IntegrationPackage): Promise<void> {
    validateIntegrationPackage(pkg);
    if (!pkg.firstParty && !await this.signatures.verify({
      id: pkg.manifest.id, version: pkg.manifest.version, integrity: pkg.manifest.integrity, signature: pkg.manifest.signature,
    })) throw new Error(`Integration "${ pkg.manifest.id }" signature verification failed`);
  }

  async load(pkg: IntegrationPackage): Promise<{ integration: Integration; api: IntegrationRuntimeApi }> {
    await this.verifyPackage(pkg);
    if (!pkg.firstParty && !await this.grants.isGranted(pkg.manifest.id, pkg.manifest.version, pkg.manifest.permissions)) {
      throw new Error(`Integration "${ pkg.manifest.id }" has not been granted: ${ pkg.manifest.permissions.join(', ') || 'no permissions' }`);
    }
    const declared = new Set((pkg.manifest.proxyPaths ?? []).map(route => `${ route.method.toUpperCase() } ${ route.path }`));
    const api: IntegrationRuntimeApi = Object.freeze({
      proxy: async(input: { method: string; path: string; body?: unknown }) => {
        const key = `${ input.method.toUpperCase() } ${ input.path }`;
        if (!declared.has(key)) throw new Error(`Integration proxy path is not declared: ${ key }`);
        return await this.proxy.request({ integrationId: pkg.manifest.id, ...input });
      },
    });
    return { integration: pkg.integration, api };
  }
}

function normalizedPermissions(permissions: readonly string[]): string[] {
  return [...new Set(permissions)].sort();
}

export function integrationGrantMatches(grant: unknown, permissions: readonly string[]): boolean {
  const value = grant as { granted?: boolean; permissions?: string[] } | undefined;
  return value?.granted === true && JSON.stringify(value.permissions) === JSON.stringify(normalizedPermissions(permissions));
}

export const integrationGrantStore: IntegrationGrantStore = {
  async isGranted(id, version, permissions) {
    const { SullaSettingsModel } = await import('../database/models/SullaSettingsModel');
    const grants = await SullaSettingsModel.get('integrationPackageGrants', {});
    const key = `${ id }@${ version }`;
    return integrationGrantMatches(grants?.[key], permissions);
  },
};

export async function setIntegrationGrant(id: string, version: string, permissions: readonly string[], granted: boolean): Promise<void> {
  const { SullaSettingsModel } = await import('../database/models/SullaSettingsModel');
  const grants = await SullaSettingsModel.get('integrationPackageGrants', {});
  const key = `${ id }@${ version }`;
  const next = { ...(grants || {}) };
  if (granted) next[key] = { granted: true, permissions: normalizedPermissions(permissions) };
  else delete next[key];
  await SullaSettingsModel.set('integrationPackageGrants', next, 'json');
}

export function loadFirstPartyPackage(pkg: IntegrationPackage): Integration {
  if (!pkg.firstParty) throw new Error('Only bundled first-party packages may bypass the user grant');
  validateIntegrationPackage(pkg);
  return pkg.integration;
}

/** Wrap signed app code as a first-party package so built-ins use the identical loader. */
export function firstPartyPackage(integration: Integration): IntegrationPackage {
  const entry = 'builtin.entry';
  const pkg: IntegrationPackage = {
    firstParty: true,
    integration,
    files: { [entry]: stableJson(integration) },
    manifest: {
      apiVersion: 'sulla/v1', kind: 'integration', id: integration.id, version: '1.0.0', sullaApi: '^1.0.0',
      permissions: [], entry, integrity: '', auth: { type: integration.oauth ? 'oauth2' : 'apiKey' }, baseUrls: [],
      signature: { algorithm: 'ed25519', keyId: 'sulla-app-bundle', value: 'verified-by-app-code-signature' },
    },
  };
  pkg.manifest.integrity = integrationPackageHash(pkg);
  return pkg;
}
