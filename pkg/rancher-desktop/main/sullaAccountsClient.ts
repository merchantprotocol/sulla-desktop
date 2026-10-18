import { isIP } from 'node:net';

import { session } from 'electron';

import { SullaAccountsBootstrap, type AccountsOwnerSession } from './sullaAccountsBootstrap';

const API = 'http://127.0.0.1:3020';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_JSON_BYTES = 256 * 1024;

export interface AccountsProfile {
  id:          string;
  displayName: string;
  createdAt:   string;
  updatedAt:   string;
}

export interface AccountsConnection {
  id:                 string;
  type:               'oidc';
  issuer:             string;
  clientId:           string;
  resourceAudiences:  string[];
  scopes:             string[];
  membershipEndpoint: string | null;
  membershipAudience: string | null;
  subject:            string | null;
  connectedAt:        string | null;
  createdAt:          string;
  updatedAt:          string;
  remoteAuthorityId:  string | null;
}

export interface AccountsConnectionInput {
  issuer:              string;
  clientId:            string;
  resourceAudiences:   string[];
  scopes:              string[];
  membershipEndpoint?: string;
  membershipAudience?: string;
  remoteAuthorityId?:  string;
}

export interface AccountsAuthorityMetadata {
  authorityId:        string;
  issuer:             string;
  nativeClientId:     string;
  nativeRedirectUris: string[];
  scopes:             string[];
  membershipAudience: string;
  resourceAudiences:  string[];
  membershipResolver: string;
}

export interface AccountsMembership {
  authorityId:    string;
  issuer:         string;
  subject:        string;
  organizationId: string;
  roles:          string[];
  groups:         string[];
  updatedAt:      string;
  expiresAt?:     string;
}

export interface AccountsMemberships {
  local:              AccountsMembership[];
  remoteDisplayHints: AccountsMembership[];
}

export interface AccountsConnections {
  connections:            AccountsConnection[];
  legacyCloudConnections: { id?: string; provider?: string; label?: string; connectedAt?: string }[];
}

interface AuthorizationLaunch {
  authorizationUrl: string;
  expiresAt:        string;
}

export class SullaAccountsError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
    this.name = 'SullaAccountsError';
  }
}

function record(value:unknown, name:string):Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SullaAccountsError(`invalid_${ name }`, 502);
  return value as Record<string, unknown>;
}

function text(value:unknown, name:string, max = 2_048):string {
  if (typeof value !== 'string' || !value || value.length > max) throw new SullaAccountsError(`invalid_${ name }`, 502);
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1F || code === 0x7F) throw new SullaAccountsError(`invalid_${ name }`, 502);
  }
  return value;
}

function identifier(value:unknown, name:string):string {
  const result = text(value, name, 36);
  if (!UUID.test(result)) throw new SullaAccountsError(`invalid_${ name }`, 502);
  return result;
}

function membershipAudience(value:unknown):string {
  const result = text(value, 'membership_audience', 120);
  if (!/^[A-Za-z0-9._-]+$/.test(result)) throw new SullaAccountsError('invalid_membership_audience', 502);
  return result;
}

function date(value:unknown, name:string):string {
  const result = text(value, name, 64);
  const parsed = new Date(result);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== result) throw new SullaAccountsError(`invalid_${ name }`, 502);
  return result;
}

function strings(value:unknown, name:string, max = 64):string[] {
  if (!Array.isArray(value) || value.length > max) throw new SullaAccountsError(`invalid_${ name }`, 502);
  return value.map((item, index) => text(item, `${ name }_${ index }`, 300));
}

function trustedUrl(value:unknown, name:string):string {
  const result = text(value, name, 4_096);
  let url:URL;
  try { url = new URL(result) } catch { throw new SullaAccountsError(`invalid_${ name }`, 502) }
  const loopbackHttp = url.protocol === 'http:' &&
    (url.hostname === 'localhost' || (isIP(url.hostname) === 4 && url.hostname.startsWith('127.')));
  if (url.username || url.password || url.hash || url.search || (url.protocol !== 'https:' && !loopbackHttp)) {
    throw new SullaAccountsError(`invalid_${ name }`, 502);
  }
  return result;
}

async function json(response:Response, name:string):Promise<unknown> {
  if (response.status === 204) return {};
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) {
    await response.body?.cancel();
    throw new SullaAccountsError(`invalid_${ name }`, 502);
  }
  if (!response.body) throw new SullaAccountsError(`invalid_${ name }`, 502);
  const reader = response.body.getReader();
  const chunks:Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_JSON_BYTES) {
        await reader.cancel();
        throw new SullaAccountsError(`invalid_${ name }`, 502);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    throw new SullaAccountsError(`invalid_${ name }`, 502);
  }
}

function profile(value:unknown):AccountsProfile {
  const input = record(value, 'profile');
  return {
    id:          identifier(input.id, 'profile_id'),
    displayName: text(input.displayName, 'display_name', 120),
    createdAt:   date(input.createdAt, 'profile_created_at'),
    updatedAt:   date(input.updatedAt, 'profile_updated_at'),
  };
}

function connection(value:unknown):AccountsConnection {
  const input = record(value, 'connection');
  if (input.type !== 'oidc') throw new SullaAccountsError('invalid_connection_type', 502);
  const issuer = trustedUrl(input.issuer, 'connection_issuer');
  const membershipEndpoint = input.membershipEndpoint === null ? null : trustedUrl(input.membershipEndpoint, 'membership_endpoint');
  const pinnedMembershipAudience = input.membershipAudience === null ? null : membershipAudience(input.membershipAudience);
  if (membershipEndpoint && new URL(membershipEndpoint).origin !== new URL(issuer).origin) {
    throw new SullaAccountsError('invalid_membership_endpoint', 502);
  }
  const remoteAuthorityId = input.remoteAuthorityId === null ? null : identifier(input.remoteAuthorityId, 'remote_authority_id');
  if (Boolean(membershipEndpoint) !== Boolean(remoteAuthorityId) || Boolean(membershipEndpoint) !== Boolean(pinnedMembershipAudience)) {
    throw new SullaAccountsError('invalid_remote_membership_contract', 502);
  }
  return {
    id:                 identifier(input.id, 'connection_id'),
    type:               'oidc',
    issuer,
    clientId:           text(input.clientId, 'client_id', 300),
    resourceAudiences:  strings(input.resourceAudiences, 'resource_audiences'),
    scopes:             strings(input.scopes, 'scopes'),
    membershipEndpoint,
    membershipAudience: pinnedMembershipAudience,
    subject:            input.subject === null ? null : text(input.subject, 'subject', 1_000),
    connectedAt:        input.connectedAt === null ? null : date(input.connectedAt, 'connected_at'),
    createdAt:          date(input.createdAt, 'connection_created_at'),
    updatedAt:          date(input.updatedAt, 'connection_updated_at'),
    remoteAuthorityId,
  };
}

function membership(value:unknown, remote:boolean):AccountsMembership {
  const input = record(value, 'membership');
  const pick = (camel:string, snake:string) => input[camel] ?? input[snake];
  return {
    authorityId:    identifier(pick('authorityId', 'authority_id'), 'membership_authority_id'),
    issuer:         trustedUrl(input.issuer, 'membership_issuer'),
    subject:        text(input.subject, 'membership_subject', 1_000),
    organizationId: identifier(pick('organizationId', 'organization_id'), 'membership_organization_id'),
    roles:          strings(input.roles, 'membership_roles'),
    groups:         strings(input.groups, 'membership_groups'),
    updatedAt:      date(pick(remote ? 'sourceUpdatedAt' : 'updatedAt', remote ? 'source_updated_at' : 'updated_at'), 'membership_updated_at'),
    ...(remote ? { expiresAt: date(pick('expiresAt', 'expires_at'), 'membership_expires_at') } : {}),
  };
}

function normalizeConnectionInput(value:AccountsConnectionInput):AccountsConnectionInput {
  const input = record(value, 'connection_input');
  const issuer = trustedUrl(input.issuer, 'issuer');
  const membershipEndpoint = input.membershipEndpoint === undefined ? undefined : trustedUrl(input.membershipEndpoint, 'membership_endpoint');
  const pinnedMembershipAudience = input.membershipAudience === undefined ? undefined : membershipAudience(input.membershipAudience);
  if (membershipEndpoint && new URL(membershipEndpoint).origin !== new URL(issuer).origin) {
    throw new SullaAccountsError('invalid_membership_endpoint', 400);
  }
  const scopes = strings(input.scopes, 'scopes');
  if (!scopes.includes('openid')) throw new SullaAccountsError('openid_scope_required', 400);
  const remoteAuthorityId = input.remoteAuthorityId === undefined ? undefined : identifier(input.remoteAuthorityId, 'remote_authority_id');
  if (Boolean(membershipEndpoint) !== Boolean(remoteAuthorityId) || Boolean(membershipEndpoint) !== Boolean(pinnedMembershipAudience)) {
    throw new SullaAccountsError('remote_membership_contract_incomplete', 400);
  }
  return {
    issuer,
    clientId:          text(input.clientId, 'client_id', 300),
    resourceAudiences: strings(input.resourceAudiences, 'resource_audiences'),
    scopes,
    ...(membershipEndpoint ? { membershipEndpoint } : {}),
    ...(pinnedMembershipAudience ? { membershipAudience: pinnedMembershipAudience } : {}),
    ...(remoteAuthorityId ? { remoteAuthorityId } : {}),
  };
}

export class SullaAccountsClient {
  private ownerSession?:   AccountsOwnerSession;
  private initialization?: Promise<AccountsProfile>;
  private rotation?:       Promise<string>;

  constructor(private readonly bootstrap = new SullaAccountsBootstrap()) {}

  initialize():Promise<AccountsProfile> {
    this.initialization ??= this.bootstrapSession().finally(() => { this.initialization = undefined });
    return this.initialization;
  }

  shutdown():void {
    this.ownerSession = undefined;
    this.rotation = undefined;
  }

  private async fetchJson(requestPath:string, init:RequestInit, token?:string):Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/json');
    if (init.body) headers.set('content-type', 'application/json');
    if (token) headers.set('authorization', `Bearer ${ token }`);
    let response:Response;
    try {
      response = await session.defaultSession.fetch(`${ API }${ requestPath }`, {
        ...init, headers, redirect: 'error', signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new SullaAccountsError('accounts_unavailable', 503);
    }
    const body = await json(response, 'accounts_response');
    if (!response.ok) {
      const error = record(body, 'error_response');
      throw new SullaAccountsError(typeof error.error === 'string' && /^[a-z0-9_]{1,80}$/.test(error.error) ? error.error : 'accounts_request_failed', response.status);
    }
    return body;
  }

  private async bootstrapSession():Promise<AccountsProfile> {
    const secret = await this.bootstrap.readSecret();
    const response = record(await this.fetchJson('/v1/private/bootstrap/session', { method: 'POST', body: '{}' }, secret), 'bootstrap_response');
    const ownerSession = {
      token:     text(response.token, 'session_token', 16_384),
      expiresAt: date(response.expiresAt, 'session_expiry'),
    };
    if (Date.parse(ownerSession.expiresAt) <= Date.now()) throw new SullaAccountsError('invalid_session_expiry', 502);
    this.ownerSession = ownerSession;
    return profile(response.profile);
  }

  private async sessionToken():Promise<string> {
    if (!this.ownerSession) await this.initialize();
    if (Date.parse(this.ownerSession!.expiresAt) - Date.now() <= 60_000) {
      this.rotation ??= this.refreshSession().finally(() => { this.rotation = undefined });
      return this.rotation;
    }
    return this.ownerSession!.token;
  }

  private async refreshSession():Promise<string> {
    const response = record(await this.fetchJson('/v1/sessions/refresh', { method: 'POST', body: '{}' }, this.ownerSession!.token), 'session_refresh');
    this.ownerSession = { token: text(response.token, 'session_token', 16_384), expiresAt: date(response.expiresAt, 'session_expiry') };
    return this.ownerSession.token;
  }

  private async request(requestPath:string, init:RequestInit = {}, retry = true):Promise<unknown> {
    try {
      return await this.fetchJson(requestPath, init, await this.sessionToken());
    } catch (error) {
      if (retry && error instanceof SullaAccountsError && error.status === 401) {
        this.ownerSession = undefined;
        await this.initialize();
        return this.request(requestPath, init, false);
      }
      throw error;
    }
  }

  async getProfile():Promise<AccountsProfile> { return profile(await this.request('/v1/profile')) }

  async updateProfile(displayName:string):Promise<AccountsProfile> {
    return profile(await this.request('/v1/profile', {
      method: 'PATCH', body: JSON.stringify({ displayName: text(displayName?.trim(), 'display_name', 120) }),
    }));
  }

  async listConnections():Promise<AccountsConnections> {
    const response = record(await this.request('/v1/connections'), 'connections_response');
    if (!Array.isArray(response.connections) || !Array.isArray(response.legacyCloudConnections)) throw new SullaAccountsError('invalid_connections_response', 502);
    const legacyCloudConnections = response.legacyCloudConnections.slice(0, 64).map((value) => {
      const item = record(value, 'legacy_connection');
      const result:AccountsConnections['legacyCloudConnections'][number] = {};
      if (item.id !== undefined) result.id = text(item.id, 'legacy_id', 300);
      if (item.provider !== undefined) result.provider = text(item.provider, 'legacy_provider', 120);
      if (item.label !== undefined) result.label = text(item.label, 'legacy_label', 300);
      if (item.connectedAt !== undefined) result.connectedAt = date(item.connectedAt, 'legacy_connected_at');
      return result;
    });
    return { connections: response.connections.map(connection), legacyCloudConnections };
  }

  async createConnection(input:AccountsConnectionInput):Promise<AccountsConnection> {
    return connection(await this.request('/v1/connections', { method: 'POST', body: JSON.stringify(normalizeConnectionInput(input)) }));
  }

  async discoverAuthority(baseUrl:string):Promise<AccountsAuthorityMetadata> {
    const origin = trustedUrl(baseUrl, 'authority_url');
    let response:Response;
    try {
      response = await session.defaultSession.fetch(new URL('/.well-known/sulla-authority', origin).href, {
        redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: { accept: 'application/json' },
      });
    } catch {
      throw new SullaAccountsError('authority_discovery_unavailable', 503);
    }
    const metadata = record(await json(response, 'authority_metadata'), 'authority_metadata');
    if (!response.ok) throw new SullaAccountsError('authority_discovery_unavailable', 503);
    const issuer = trustedUrl(metadata.issuer, 'authority_issuer');
    const membershipResolver = trustedUrl(metadata.membershipResolver, 'membership_resolver');
    if (new URL(issuer).origin !== new URL(origin).origin || new URL(membershipResolver).origin !== new URL(origin).origin) {
      throw new SullaAccountsError('invalid_authority_metadata', 502);
    }
    if (!Array.isArray(metadata.nativeRedirectUris) || metadata.nativeRedirectUris.length !== 1 ||
        metadata.nativeRedirectUris[0] !== `${ API }/v1/oidc/callback`) {
      throw new SullaAccountsError('invalid_authority_metadata', 502);
    }
    return {
      authorityId:        identifier(metadata.authorityId, 'authority_id'),
      issuer,
      nativeClientId:     text(metadata.nativeClientId, 'native_client_id', 300),
      nativeRedirectUris: [`${ API }/v1/oidc/callback`],
      scopes:             strings(metadata.scopes, 'authority_scopes'),
      membershipAudience: membershipAudience(metadata.membershipAudience),
      resourceAudiences:  strings(metadata.resourceAudiences, 'resource_audiences'),
      membershipResolver,
    };
  }

  async enrollAuthority(baseUrl:string):Promise<AccountsConnection> {
    const metadata = await this.discoverAuthority(baseUrl);
    return this.createConnection({
      issuer:              metadata.issuer,
      clientId:            metadata.nativeClientId,
      resourceAudiences:   metadata.resourceAudiences,
      scopes:              metadata.scopes,
      membershipEndpoint: metadata.membershipResolver,
      membershipAudience: metadata.membershipAudience,
      remoteAuthorityId:  metadata.authorityId,
    });
  }

  async removeConnection(id:string):Promise<void> {
    const connectionId = identifier(id, 'connection_id');
    await this.request(`/v1/connections/${ encodeURIComponent(connectionId) }`, { method: 'DELETE' });
  }

  async beginAuthorization(id:string, resourceAudience?:string):Promise<{ authorizationUrl: string; expiresAt: string }> {
    const connectionId = identifier(id, 'connection_id');
    const selected = (await this.listConnections()).connections.find(item => item.id === connectionId);
    if (!selected) throw new SullaAccountsError('connection_not_found', 404);
    if (resourceAudience !== undefined && !selected.resourceAudiences.includes(resourceAudience)) {
      throw new SullaAccountsError('resource_audience_not_allowed', 400);
    }
    const response = record(await this.request(`/v1/connections/${ encodeURIComponent(connectionId) }/authorize`, {
      method: 'POST', body: JSON.stringify(resourceAudience === undefined ? {} : { resourceAudience: text(resourceAudience, 'resource_audience', 300) }),
    }), 'authorization_response');
    const launch:AuthorizationLaunch = {
      authorizationUrl: text(response.authorizationUrl, 'authorization_url', 16_384),
      expiresAt:        date(response.expiresAt, 'authorization_expiry'),
    };
    await this.assertAuthorizationUrl(selected, launch.authorizationUrl);
    return launch;
  }

  private async assertAuthorizationUrl(selected:AccountsConnection, candidate:string):Promise<void> {
    const issuer = new URL(selected.issuer);
    const authorization = new URL(candidate);
    if (authorization.username || authorization.password || authorization.hash || authorization.origin !== issuer.origin) {
      throw new SullaAccountsError('invalid_authorization_url', 502);
    }
    const discoveryUrl = `${ selected.issuer }${ selected.issuer.endsWith('/') ? '' : '/' }.well-known/openid-configuration`;
    const metadataResponse = await session.defaultSession.fetch(discoveryUrl, {
      redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: { accept: 'application/json' },
    }).catch(() => { throw new SullaAccountsError('authority_discovery_unavailable', 503) });
    const metadata = record(await json(metadataResponse, 'authority_metadata'), 'authority_metadata');
    if (!metadataResponse.ok) throw new SullaAccountsError('authority_discovery_unavailable', 503);
    if (metadata.issuer !== selected.issuer) throw new SullaAccountsError('invalid_authority_metadata', 502);
    const expected = new URL(trustedUrl(metadata.authorization_endpoint, 'authorization_endpoint'));
    if (expected.origin !== issuer.origin || authorization.origin !== expected.origin || authorization.pathname !== expected.pathname) {
      throw new SullaAccountsError('invalid_authorization_url', 502);
    }
    const redirect = authorization.searchParams.get('redirect_uri');
    if (redirect !== `${ API }/v1/oidc/callback` || authorization.searchParams.get('client_id') !== selected.clientId ||
        authorization.searchParams.get('response_type') !== 'code' || authorization.searchParams.get('code_challenge_method') !== 'S256' ||
        !authorization.searchParams.get('state') || !authorization.searchParams.get('code_challenge')) {
      throw new SullaAccountsError('invalid_authorization_url', 502);
    }
  }

  async listMemberships():Promise<AccountsMemberships> {
    const response = record(await this.request('/v1/memberships'), 'memberships_response');
    if (!Array.isArray(response.local) || !Array.isArray(response.remoteDisplayHints)) throw new SullaAccountsError('invalid_memberships_response', 502);
    return {
      local:              response.local.map(value => membership(value, false)),
      remoteDisplayHints: response.remoteDisplayHints.map(value => membership(value, true)),
    };
  }
}

let instance:SullaAccountsClient | undefined;
export function getSullaAccountsClient():SullaAccountsClient {
  instance ??= new SullaAccountsClient();
  return instance;
}
