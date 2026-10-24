import assert from 'node:assert/strict';
import test from 'node:test';

import { digest } from './crypto.js';
import { beginWebLogin, completeWebLogin } from './webAuth.js';

import type { AccountsConfig } from './config.js';
import type { Database } from './db.js';
import type { Request, Response } from 'express';

const config = {
  mode: 'server', port: 3020, databaseUrl: '', publicUrl: 'https://console.example',
  allowedReturnOrigins: new Set<string>(), sessionSecret: Buffer.alloc(32), encryptionKey: Buffer.alloc(32, 1),
  serviceTokens: new Map(), keycloakIssuer: 'https://console.example/auth/realms/sulla',
  keycloakAuthorityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', keycloakNativeClientId: 'sulla-desktop',
  keycloakWebClientId: 'sulla-web', keycloakWebClientSecret: 'synthetic-web-secret',
  keycloakAdminUsername: 'synthetic-admin', keycloakAdminPassword: 'synthetic-password',
  keycloakMembershipAudience: 'sulla-membership', keycloakResourceAudiences: new Set(['sulla-files']),
  webCallbackUrl: 'https://console.example/accounts-api/v1/web/callback', consoleMainUrl: 'https://console.example/console',
  serverId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', serverDisplayName: 'Synthetic Server',
  secureCookies: true, trustedProxy: true,
} satisfies AccountsConfig;

test('web login binds state to an HttpOnly initiating-browser cookie and safely rejects malformed return paths', async() => {
  let inserted: unknown[] = [];
  let cookie: { name: string; value: string; options: Record<string, unknown> } | undefined;
  const db = {
    query: async(sql: string, values?: unknown[]) => {
      if (sql.startsWith('SELECT * FROM accounts.authorities')) return { rows: [{ authorization_endpoint: 'https://console.example/auth/realms/sulla/protocol/openid-connect/auth' }] };
      inserted = values ?? [];
      return { rows: [] };
    },
  } as unknown as Database;
  const response = { cookie: (name: string, value: string, options: Record<string, unknown>) => { cookie = { name, value, options }; } } as unknown as Response;

  const url = await beginWebLogin(db, config, 'http://[invalid', response);
  assert.equal(new URL(url).searchParams.get('redirect_uri'), config.webCallbackUrl);
  assert.equal(inserted[7], config.consoleMainUrl);
  await beginWebLogin(db, config, '/console-impersonation', response);
  assert.equal(inserted[7], config.consoleMainUrl);
  assert.equal(cookie?.name, 'sulla-console-login');
  assert.equal(cookie?.options.httpOnly, true);
  assert.equal(cookie?.options.sameSite, 'lax');
  assert.deepEqual(inserted[2], digest(cookie!.value));
});

test('web callback rejects a state replay from a browser without the initiating binding cookie before token exchange', async() => {
  const transaction = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab', consumed_at: null,
    expires_at: new Date(Date.now() + 60_000), browser_binding_digest: digest('correct-browser-binding'),
  };
  const client = {
    query: async(sql: string) => sql.startsWith('SELECT * FROM accounts.web_authorization_transactions') ? { rows: [transaction] } : { rows: [] },
    release: () => undefined,
  };
  const db = { connect: async() => client } as unknown as Database;
  const request = { header: (name: string) => name.toLowerCase() === 'cookie' ? 'sulla-console-login=wrong-browser-binding' : undefined } as Request;
  const response = {} as Response;

  await assert.rejects(
    completeWebLogin(db, config, 'synthetic-code', 'synthetic-state', request, response),
    /browser binding mismatch/,
  );
});
