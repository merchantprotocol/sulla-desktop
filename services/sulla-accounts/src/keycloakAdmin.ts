import { object, string } from './http.js';

import type { AccountsConfig } from './config.js';

export interface HostedUser {
  id: string;
  username: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  enabled: boolean;
}

function endpoints(config: AccountsConfig): { token: string; realm: string; users: string } {
  if (!config.keycloakIssuer) throw new Error('hosted authority is unavailable');
  const issuer = new URL(config.keycloakIssuer);
  const marker = '/auth/realms/';
  const index = issuer.pathname.indexOf(marker);
  if (index < 0) throw new Error('hosted issuer has an invalid realm path');
  const realm = issuer.pathname.slice(index + marker.length);
  if (!/^[A-Za-z0-9._-]+$/.test(realm)) throw new Error('hosted realm is invalid');
  return {
    token: 'http://127.0.0.1:8080/auth/realms/master/protocol/openid-connect/token',
    realm: `http://127.0.0.1:8080/auth/admin/realms/${encodeURIComponent(realm)}`,
    users: `http://127.0.0.1:8080/auth/admin/realms/${encodeURIComponent(realm)}/users`,
  };
}

async function adminToken(config: AccountsConfig): Promise<string> {
  if (!config.keycloakAdminUsername || !config.keycloakAdminPassword)
    throw new Error('Keycloak administration is unavailable');
  const response = await fetch(endpoints(config).token, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(8_000),
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: config.keycloakAdminUsername,
      password: config.keycloakAdminPassword,
    }),
  });
  if (!response.ok) throw new Error('Keycloak administrator authentication failed');
  return string(object(await response.json()).access_token, 'admin access token', 64 * 1024);
}

async function keycloakRequest(config: AccountsConfig, url: string, init: RequestInit = {}): Promise<Response> {
  const token = await adminToken(config);
  const response = await fetch(url, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(8_000),
    headers: { accept: 'application/json', authorization: `Bearer ${token}`, ...init.headers },
  });
  if (!response.ok) throw new Error(`Keycloak administration failed (${response.status})`);
  return response;
}

function publicUser(input: unknown): HostedUser {
  const user = object(input);
  return {
    id: string(user.id, 'user id', 64),
    username: string(user.username, 'username', 254),
    email: typeof user.email === 'string' ? user.email : undefined,
    firstName: typeof user.firstName === 'string' ? user.firstName : undefined,
    lastName: typeof user.lastName === 'string' ? user.lastName : undefined,
    enabled: user.enabled === true,
  };
}

export async function getHostedUser(config: AccountsConfig, id: string): Promise<HostedUser> {
  const response = await keycloakRequest(config, `${endpoints(config).users}/${encodeURIComponent(id)}`);
  return publicUser(await response.json());
}

export async function createHostedUser(
  config: AccountsConfig,
  input: {
    username: string;
    email?: string;
    firstName?: string;
    lastName?: string;
    password?: string;
    temporaryPassword?: boolean;
  },
): Promise<HostedUser> {
  const users = endpoints(config).users;
  const response = await keycloakRequest(config, users, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: input.username,
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      enabled: true,
      emailVerified: false,
      ...(input.password
        ? { credentials: [{ type: 'password', value: input.password, temporary: input.temporaryPassword ?? true }] }
        : {}),
    }),
  });
  const location = response.headers.get('location');
  const id = location?.split('/').pop();
  if (!id) throw new Error('Keycloak did not identify the created user');
  const created = await keycloakRequest(config, `${users}/${encodeURIComponent(id)}`);
  return publicUser(await created.json());
}

export async function updateHostedUser(config: AccountsConfig, id: string, enabled: boolean): Promise<void> {
  const users = endpoints(config).users;
  const current = await keycloakRequest(config, `${users}/${encodeURIComponent(id)}`);
  const payload = object(await current.json());
  await keycloakRequest(config, `${users}/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, enabled }),
  });
}

export async function updateHostedUserProfile(
  config: AccountsConfig,
  id: string,
  input: {
    email?: string;
    firstName?: string;
    lastName?: string;
  },
): Promise<HostedUser> {
  const users = endpoints(config).users;
  const current = await keycloakRequest(config, `${users}/${encodeURIComponent(id)}`);
  const payload = object(await current.json());
  const emailChanged = input.email !== undefined && input.email !== payload.email;
  await keycloakRequest(config, `${users}/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, ...input, ...(emailChanged ? { emailVerified: false } : {}) }),
  });
  return getHostedUser(config, id);
}

export async function resetHostedPassword(config: AccountsConfig, id: string, password: string): Promise<void> {
  await keycloakRequest(config, `${endpoints(config).users}/${encodeURIComponent(id)}/reset-password`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'password', value: password, temporary: true }),
  });
}

export async function deleteHostedUser(config: AccountsConfig, id: string): Promise<void> {
  await keycloakRequest(config, `${endpoints(config).users}/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function assignHostedRealmRole(config: AccountsConfig, userId: string, roleName: string): Promise<void> {
  const base = endpoints(config);
  const role = await keycloakRequest(config, `${base.realm}/roles/${encodeURIComponent(roleName)}`);
  await keycloakRequest(config, `${base.users}/${encodeURIComponent(userId)}/role-mappings/realm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify([await role.json()]),
  });
}

export async function hasHostedRealmRole(config: AccountsConfig, userId: string, roleName: string): Promise<boolean> {
  const base = endpoints(config);
  const response = await keycloakRequest(config, `${base.users}/${encodeURIComponent(userId)}/role-mappings/realm/composite`);
  const roles = await response.json();
  return Array.isArray(roles) && roles.some(role => role?.name === roleName);
}

export async function listHostedUsers(config: AccountsConfig): Promise<HostedUser[]> {
  const response = await keycloakRequest(config, `${endpoints(config).users}?max=10000`);
  const users = await response.json();
  if (!Array.isArray(users)) throw new Error('Keycloak returned an invalid users result');
  return users.map(publicUser);
}

export async function sendHostedUserActions(
  config: AccountsConfig,
  id: string,
  actions: string[] = ['UPDATE_PASSWORD'],
): Promise<void> {
  const query = new URLSearchParams();
  if (config.keycloakWebClientId) query.set('client_id', config.keycloakWebClientId);
  if (config.consoleMainUrl) query.set('redirect_uri', config.consoleMainUrl);
  await keycloakRequest(config, `${endpoints(config).users}/${encodeURIComponent(id)}/execute-actions-email?${query}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(actions),
  });
}

export async function getRealmSettings(config: AccountsConfig): Promise<Record<string, unknown>> {
  const response = await keycloakRequest(config, endpoints(config).realm);
  return object(await response.json());
}

export async function updateRealmSettings(config: AccountsConfig, updates: Record<string, unknown>): Promise<void> {
  const current = await getRealmSettings(config);
  await keycloakRequest(config, endpoints(config).realm, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...current, ...updates, registrationAllowed: false }),
  });
}

export async function testRealmSmtp(config: AccountsConfig, smtp: Record<string, unknown>): Promise<void> {
  await keycloakRequest(config, `${endpoints(config).realm}/testSMTPConnection`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(smtp),
  });
}

export async function getRealmEvents(config: AccountsConfig, max = 100): Promise<unknown[]> {
  const query = new URLSearchParams({ max: String(Math.min(Math.max(max, 1), 500)) });
  const response = await keycloakRequest(config, `${endpoints(config).realm}/events?${query}`);
  const events = await response.json();
  if (!Array.isArray(events)) throw new Error('Keycloak returned invalid events');
  return events.filter((event) => ['LOGIN', 'LOGIN_ERROR', 'LOGOUT'].includes(String(object(event).type)));
}

export async function getOtpRequired(config: AccountsConfig): Promise<boolean> {
  const response = await keycloakRequest(config, `${endpoints(config).realm}/authentication/required-actions`);
  const actions = await response.json();
  if (!Array.isArray(actions)) throw new Error('Keycloak returned invalid required actions');
  return actions.some(
    (action) =>
      object(action).alias === 'CONFIGURE_TOTP' &&
      object(action).enabled === true &&
      object(action).defaultAction === true,
  );
}

export async function setOtpRequired(config: AccountsConfig, required: boolean): Promise<void> {
  const url = `${endpoints(config).realm}/authentication/required-actions/CONFIGURE_TOTP`;
  const current = await keycloakRequest(config, url);
  await keycloakRequest(config, url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...object(await current.json()), enabled: true, defaultAction: required }),
  });
}
