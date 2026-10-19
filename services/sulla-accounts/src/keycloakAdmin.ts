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

function endpoints(config: AccountsConfig): { token: string; users: string } {
  if (!config.keycloakIssuer) throw new Error('hosted authority is unavailable');
  const issuer = new URL(config.keycloakIssuer);
  const marker = '/auth/realms/';
  const index = issuer.pathname.indexOf(marker);
  if (index < 0) throw new Error('hosted issuer has an invalid realm path');
  const realm = issuer.pathname.slice(index + marker.length);
  if (!/^[A-Za-z0-9._-]+$/.test(realm)) throw new Error('hosted realm is invalid');
  return {
    token: 'http://127.0.0.1:8080/auth/realms/master/protocol/openid-connect/token',
    users: `http://127.0.0.1:8080/auth/admin/realms/${encodeURIComponent(realm)}/users`,
  };
}

async function adminToken(config: AccountsConfig): Promise<string> {
  if (!config.keycloakAdminUsername || !config.keycloakAdminPassword) throw new Error('Keycloak administration is unavailable');
  const response = await fetch(endpoints(config).token, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8_000),
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'password', client_id: 'admin-cli', username: config.keycloakAdminUsername, password: config.keycloakAdminPassword,
    }),
  });
  if (!response.ok) throw new Error('Keycloak administrator authentication failed');
  return string(object(await response.json()).access_token, 'admin access token', 64 * 1024);
}

async function keycloakRequest(config: AccountsConfig, url: string, init: RequestInit = {}): Promise<Response> {
  const token = await adminToken(config);
  const response = await fetch(url, {
    ...init, redirect: 'error', signal: AbortSignal.timeout(8_000),
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

export async function createHostedUser(config: AccountsConfig, input: {
  username: string; email?: string; firstName?: string; lastName?: string; password: string;
}): Promise<HostedUser> {
  const users = endpoints(config).users;
  const response = await keycloakRequest(config, users, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: input.username, email: input.email, firstName: input.firstName, lastName: input.lastName,
      enabled: true, emailVerified: false,
      credentials: [{ type: 'password', value: input.password, temporary: true }],
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
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, enabled }),
  });
}

export async function resetHostedPassword(config: AccountsConfig, id: string, password: string): Promise<void> {
  await keycloakRequest(config, `${endpoints(config).users}/${encodeURIComponent(id)}/reset-password`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'password', value: password, temporary: true }),
  });
}
