import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';

import pg from 'pg';
import { DEFAULT_AGENT_POLICY, deriveMasterKey } from '@sulla/vault-crypto';

import { migrate } from './db.js';
import { createApp } from './app.js';
import { validateCatalogRequest } from './catalogPolicy.js';
import { LocalVaultAuthority, LocalVaultError, localAuthorityTestHooks } from './localAuthority.js';
import { validateOAuthRegistrationRequest } from './oauthPolicy.js';
import { validateOperation } from './operationPolicy.js';
import {
  bootstrapSessionKeyInput,
  bootstrapUnlockProofInput,
  cacheUpdateChallengeProofInput,
  cacheUpdateFetchProofInput,
  cacheUpdateServerProofInput,
  cacheUpdateSessionKeyInput,
} from './contracts.js';

import type { VaultConfig } from './config.js';

const SYNTHETIC_DATABASE_URL = process.env.SULLA_VAULT_TEST_DATABASE_URL;
const TOKEN = {
  bootstrap: 'bootstrap_' + 'a'.repeat(64),
  control:   'control_' + 'b'.repeat(64),
  approval:  'approval_' + 'c'.repeat(64),
  broker:    'broker_' + 'd'.repeat(64),
};

function config(databaseUrl: string): VaultConfig {
  return {
    mode: 'desktop', port: 8787, databaseUrl, jwtSecret: 'j'.repeat(64), extensionOrigins: [],
    bootstrapServiceId: 'sulla-desktop-bootstrap', bootstrapServiceToken: TOKEN.bootstrap,
    controlServiceId: 'sulla-desktop-control', controlServiceToken: TOKEN.control,
    approvalServiceId: 'sulla-desktop-approval', approvalServiceToken: TOKEN.approval,
    brokerServiceId: 'sulla-tools', brokerServiceToken: TOKEN.broker,
    humanUiOrigin: 'https://127.0.0.1:30135', legacyDatabaseUrl: databaseUrl,
  };
}

function proof(value: string): string {
  return createHmac('sha256', TOKEN.bootstrap).update(value).digest('base64url');
}

test('bootstrap challenge rejects forgery, replay, expiry, and consumes unlock challenge', async(t) => {
  const authority = new LocalVaultAuthority({ query: async() => ({ rowCount: 0, rows: [] }) } as any, config('postgresql://synthetic/unused'));
  const callerId = 'sulla-desktop-bootstrap';
  const clientNonce = randomBytes(32).toString('base64url');
  assert.throws(() => authority.createChallenge(callerId, clientNonce, 'forged'), (error: any) => error.code === 'invalid_service_identity');
  const challenge = authority.createChallenge(callerId, clientNonce, proof(`challenge:${ callerId }:${ clientNonce }`));
  (authority as any).challenges.get(challenge.challengeId).expiresAt = Date.now() - 1;
  await assert.rejects(authority.unlock({ callerId, challengeId: challenge.challengeId, clientProof: 'x', sealedUnlock: 'x' }),
    (error: any) => error.code === 'invalid_bootstrap_challenge');
  await assert.rejects(authority.unlock({ callerId, challengeId: challenge.challengeId, clientProof: 'x', sealedUnlock: 'x' }),
    (error: any) => error.code === 'invalid_bootstrap_challenge');
  authority.lock();
  assert.equal(authority.status().unlocked, false);
});

test('approval digest binds headers, body, account, repository and response mode', () => {
  const base: any = {
    claims: { sub: 'user', agent_id: 'agent', pod_id: 'pod', credential_scope: { integration_id: 'github', account_id: 'one', repository: 'o/r' } },
    operation: 'github.git', ref: { integrationId: 'github', accountId: 'one' }, url: 'https://github.com/o/r.git/git-upload-pack',
    method: 'POST', headers: { accept: 'application/x-git-upload-pack-result' }, body: 'YQ==', bodyEncoding: 'base64',
    injections: [{ field: 'token', target: 'header', name: 'authorization', scheme: 'GitHubBasic' }], responseType: 'binary-stream',
  };
  const digest = localAuthorityTestHooks.operationDigest(base);
  for (const changed of [
    { ...base, body: 'Yg==' },
    { ...base, headers: { accept: 'text/plain' } },
    { ...base, ref: { ...base.ref, accountId: 'two' } },
    { ...base, claims: { ...base.claims, credential_scope: { ...base.claims.credential_scope, repository: 'o/other' } } },
  ]) assert.notEqual(localAuthorityTestHooks.operationDigest(changed), digest);
});

test('private and reserved IPv4/IPv6 destinations are denied', () => {
  for (const address of ['127.0.0.1', '10.2.3.4', '169.254.1.1', '::1', 'fc00::1', 'fe80::1', '2001:db8::1', '::ffff:127.0.0.1']) {
    assert.equal(localAuthorityTestHooks.privateAddress(address), true, address);
  }
  assert.equal(localAuthorityTestHooks.privateAddress('8.8.8.8'), false);
  assert.equal(localAuthorityTestHooks.privateAddress('2606:4700:4700::1111'), false);
});

test('audio policy binds each provider credential to its own host, path, and injection', () => {
  const base: any = {
    claims: { sub: 'user', agent_id: 'agent', pod_id: 'pod' },
    operation: 'provider.audio',
    ref: { integrationId: 'elevenlabs', accountId: 'default' },
    url: 'https://api.elevenlabs.io/v1/text-to-speech/voice_1/stream',
    method: 'POST',
    injections: [{ field: 'api_key', target: 'header', name: 'xi-api-key', scheme: 'raw' }],
    responseType: 'binary-stream',
  };
  assert.doesNotThrow(() => validateOperation(base, 'api.elevenlabs.io', DEFAULT_AGENT_POLICY));
  assert.throws(() => validateOperation({
    ...base,
    url: 'https://api.x.ai/v1/tts',
    injections: [{ field: 'api_key', target: 'header', name: 'authorization', scheme: 'Bearer' }],
  }, 'api.x.ai', DEFAULT_AGENT_POLICY), /destination_denied/);
});

test('enterprise gateway policy binds methods, paths, and credential injection', () => {
  const policy = { ...DEFAULT_AGENT_POLICY, sites: ['gateway.example.com'] };
  const request: any = {
    claims: { sub: 'user', agent_id: 'agent', pod_id: 'pod' },
    operation: 'enterprise.gateway.http', ref: { integrationId: 'enterprise_gateway', accountId: 'default' },
    url: 'https://gateway.example.com/api/desktop/sessions', method: 'POST',
    injections: [{ field: 'api_key', target: 'header', name: 'authorization', scheme: 'Bearer' }],
  };
  assert.doesNotThrow(() => validateOperation(request, 'gateway.example.com', policy));
  assert.throws(() => validateOperation({ ...request, method: 'DELETE' }, 'gateway.example.com', policy), /method_denied/);
  assert.throws(() => validateOperation({ ...request, url: 'https://gateway.example.com/api/desktop/sessions/id' }, 'gateway.example.com', policy), /method_denied/);
  assert.doesNotThrow(() => validateOperation({ ...request, method: 'DELETE', url: 'https://gateway.example.com/api/desktop/sessions/id' }, 'gateway.example.com', policy));
});

test('Robinhood registration accepts only bounded loopback public-client metadata', () => {
  const body = {
    client_name: 'Sulla Desktop - Robinhood',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    redirect_uris: ['http://127.0.0.1:49152/oauth/callback'],
  };
  assert.doesNotThrow(() => validateOAuthRegistrationRequest(body));
  assert.throws(() => validateOAuthRegistrationRequest({ ...body, redirect_uris: ['https://attacker.example/callback'] }), /invalid_registration_metadata/);
  assert.throws(() => validateOAuthRegistrationRequest({ ...body, client_secret: 'caller-controlled' }), /invalid_registration_metadata/);
  const request: any = {
    claims: { sub: 'user', agent_id: 'desktop-oauth', pod_id: 'desktop-main' },
    operation: 'oauth.register', ref: { integrationId: 'robinhood', accountId: 'default' },
    url: 'https://agent.robinhood.com/oauth/trading/register', method: 'POST', body,
    headers: {}, injections: [], responseType: 'json',
  };
  assert.doesNotThrow(() => validateOperation(request, 'agent.robinhood.com', DEFAULT_AGENT_POLICY));
  assert.throws(() => validateOperation({ ...request, url: 'https://agent.robinhood.com/oauth/register' }, 'agent.robinhood.com', DEFAULT_AGENT_POLICY), /path_denied/);
});

test('bodyless MCP stream statuses do not require content type', () => {
  assert.equal(localAuthorityTestHooks.streamResponseIsBodyless('POST', 202, undefined), true);
  assert.equal(localAuthorityTestHooks.streamResponseIsBodyless('POST', 204, undefined), true);
  assert.equal(localAuthorityTestHooks.streamResponseIsBodyless('HEAD', 200, undefined), true);
  assert.equal(localAuthorityTestHooks.streamResponseIsBodyless('POST', 200, '0'), true);
  assert.equal(localAuthorityTestHooks.streamResponseIsBodyless('POST', 200, undefined), false);
});

test('MCP manifest permits credential-free calls only when explicitly public', async() => {
  const manifest = (auth: 'none' | 'required') => ({
    'mcp-public.v1-auth.yaml': 'api:\n  base_url: https://mcp.example.com/rpc\nauth:\n  type: bearer\n',
    'call.v1.yaml': `endpoint:\n  path: /rpc\n  method: POST\n  auth: ${ auth }\n`,
  });
  const input: any = {
    operation: 'mcp.http', ref: { integrationId: 'mcp', accountId: 'public' },
    method: 'POST', url: 'https://mcp.example.com/rpc', injections: [],
  };
  const db = { query: async() => ({ rows: [{ files: manifest('none') }] }) } as any;
  assert.deepEqual(await validateCatalogRequest(db, input, new URL(input.url)), { credentialFree: true });
  db.query = async() => ({ rows: [{ files: manifest('required') }] });
  await assert.rejects(validateCatalogRequest(db, input, new URL(input.url)), /injection_denied/);
});

test('stream redaction covers short, unicode, encoded, and every split boundary', () => {
  const secrets = ['x', 'short', 'påss word'];
  const text = `before x Bearer short ${ encodeURIComponent('påss word') } after`;
  const expected = Buffer.from('before [REDACTED] [REDACTED] [REDACTED] after');
  for (let split = 0; split <= Buffer.byteLength(text); split += 1) {
    const redactor = new localAuthorityTestHooks.StreamingRedactor(secrets);
    const input = Buffer.from(text);
    const actual = Buffer.concat([redactor.transform(input.subarray(0, split)), redactor.transform(input.subarray(split)), redactor.flush()]);
    assert.deepEqual(actual, expected, `split ${ split }`);
  }
});

test('synthetic pre-unlock flow rotates sessions and migration is idempotent without changing legacy rows', { skip: !SYNTHETIC_DATABASE_URL }, async() => {
  const admin = new pg.Pool({ connectionString: SYNTHETIC_DATABASE_URL, max: 1 });
  const schema = `vault_authority_${ process.pid }_${ Date.now() }`;
  await admin.query(`CREATE SCHEMA ${ schema }`);
  const url = new URL(SYNTHETIC_DATABASE_URL!);
  url.searchParams.set('options', `-c search_path=${ schema }`);
  const db = new pg.Pool({ connectionString: url.toString(), max: 4 });
  try {
    await migrate(db);
    await db.query(`CREATE TABLE integration_values(value_id bigserial primary key,integration_id text not null,account_id text not null,property text not null,value text not null,is_default boolean not null default false,created_at timestamptz default now(),updated_at timestamptz default now())`);
    await db.query(`CREATE TABLE oauth_tokens(token_id bigserial primary key,integration_id text not null,account_id text not null,provider_id text not null,access_token text not null,refresh_token text,token_type text,scope text,expires_at bigint,created_at timestamptz default now(),updated_at timestamptz default now())`);
    await db.query(`CREATE TABLE integration_definitions(slug text primary key,files jsonb not null)`);
    const legacyVmk = randomBytes(32);
    const legacyNonce = randomBytes(12);
    const legacyCipher = createCipheriv('aes-256-gcm', legacyVmk, legacyNonce);
    const legacyCiphertext = Buffer.concat([legacyCipher.update('synthetic-only-secret'), legacyCipher.final()]);
    const legacyValue = `$VAULT$${ Buffer.concat([legacyNonce, legacyCipher.getAuthTag(), legacyCiphertext]).toString('base64') }`;
    legacyCiphertext.fill(0);
    await db.query(`INSERT INTO integration_values(integration_id,account_id,property,value) VALUES ('openai','default','api_key',$1),('openai','default','llm_access','autofill')`, [legacyValue]);
    const authority = new LocalVaultAuthority(db, config(url.toString()));
    const grant = authority.createHumanSession('sulla-desktop-control', TOKEN.control);
    await assert.rejects(authority.unlockHumanSession(grant.sessionId, undefined, 'synthetic password'), (error: any) => error.code === 'invalid_csrf');
    const unlocked = await authority.unlockHumanSession(grant.sessionId, grant.csrf, 'synthetic password');
    assert.equal(unlocked.phase, 'unlocked');
    assert.equal(unlocked.state, 'migration_required');
    assert.throws(() => authority.validateHumanSession(grant.sessionId, grant.csrf), (error: any) => error.code === 'invalid_human_session');
    assert.equal(authority.status().cacheUpdateRequired, true);
    const attachCaller = 'sulla-desktop-bootstrap';
    const attachNonce = randomBytes(32).toString('base64url');
    const attachChallenge = authority.createCacheUpdateChallenge(
      attachCaller, attachNonce, proof(cacheUpdateChallengeProofInput(attachCaller, attachNonce)),
    );
    const attachSessionKey = createHmac('sha256', TOKEN.bootstrap).update(cacheUpdateSessionKeyInput(
      attachCaller, attachNonce, attachChallenge.serverNonce, attachChallenge.challengeId, attachChallenge.expiresAt,
    )).digest();
    const attachIv = randomBytes(12);
    const attachCipher = createCipheriv('aes-256-gcm', attachSessionKey, attachIv);
    const attachCiphertext = Buffer.concat([attachCipher.update(legacyVmk), attachCipher.final()]);
    const sealedLegacyVmk = Buffer.concat([attachIv, attachCipher.getAuthTag(), attachCiphertext]).toString('base64url');
    attachCiphertext.fill(0);
    const sealedLegacySha256 = createHash('sha256').update(sealedLegacyVmk).digest('base64url');
    const attachProof = proof(cacheUpdateFetchProofInput(
      attachCaller, attachNonce, attachChallenge.serverNonce, attachChallenge.challengeId,
      attachChallenge.expiresAt, sealedLegacySha256,
    ));
    authority.fetchCacheUpdate({
      callerId: attachCaller, challengeId: attachChallenge.challengeId, clientProof: attachProof, sealedLegacyVmk,
    });
    assert.throws(() => authority.fetchCacheUpdate({
      callerId: attachCaller, challengeId: attachChallenge.challengeId, clientProof: attachProof, sealedLegacyVmk,
    }), (error: any) => error.code === 'invalid_bootstrap_challenge');
    attachSessionKey.fill(0);
    legacyVmk.fill(0);
    const first = await authority.migrateLegacy('sulla-desktop-control', TOKEN.control);
    assert.equal(first.imported, 2);
    const legacyBefore = await db.query('SELECT * FROM integration_values ORDER BY value_id');
    const second = await authority.migrateLegacy('sulla-desktop-control', TOKEN.control);
    assert.equal(second.imported, 0);
    assert.equal(second.skipped, 2);
    assert.deepEqual((await db.query('SELECT * FROM integration_values ORDER BY value_id')).rows, legacyBefore.rows);

    const listed = await authority.listHumanItems(unlocked.sessionId, unlocked.csrf);
    const detail: any = await authority.revealHumanItem(unlocked.sessionId, unlocked.csrf, listed[0].id as string);
    assert.equal(detail.item.integration.properties.api_key, 'synthetic-only-secret');
    detail.item.name = 'Owner edited v2 credential';
    detail.item.agentPolicy.askFirst = true;
    await authority.saveHumanItem(unlocked.sessionId, unlocked.csrf, detail);
    await db.query(`INSERT INTO integration_values(integration_id,account_id,property,value) VALUES ('openai','default','organization','synthetic-org')`);
    const changedSource = await authority.migrateLegacy('sulla-desktop-control', TOKEN.control);
    assert.equal(changedSource.imported, 0);
    const preserved: any = await authority.revealHumanItem(unlocked.sessionId, unlocked.csrf, listed[0].id as string);
    assert.equal(preserved.item.name, 'Owner edited v2 credential');

    await db.query(`INSERT INTO integration_values(integration_id,account_id,property,value) VALUES ('broken','rollback','api_key','$VAULT$truncated')`);
    await assert.rejects(authority.migrateLegacy('sulla-desktop-control', TOKEN.control),
      (error: any) => error.code === 'migration_failed');
    assert.equal((await db.query("SELECT 1 FROM items WHERE integration_ref='broken/rollback'")).rowCount, 0);
    assert.equal((await db.query("SELECT 1 FROM integration_values WHERE integration_id='broken' AND account_id='rollback'")).rowCount, 1);
    await db.query("DELETE FROM integration_values WHERE integration_id='broken' AND account_id='rollback'");
    assert.equal((await authority.migrateLegacy('sulla-desktop-control', TOKEN.control)).state, 'unlocked');

    const user = await db.query<{ id: string }>('SELECT id FROM users LIMIT 1');
    const request: any = {
      claims: { sub: user.rows[0].id, agent_id: 'sulla', pod_id: 'synthetic', credential_scope: { integration_id: 'openai', account_id: 'default' } },
      operation: 'provider.inference', ref: { integrationId: 'openai', accountId: 'default' },
      url: 'https://api.openai.com/v1/responses', method: 'POST', body: { model: 'synthetic' },
      headers: {}, injections: [{ field: 'api_key', target: 'header', name: 'authorization', scheme: 'Bearer' }], responseType: 'json',
    };
    (authority as any).validateTarget = async(raw: string) => Object.assign(new URL(raw), { pinnedAddress: '93.184.216.34', pinnedFamily: 4 });
    (authority as any).send = async() => ({ status: 200, headers: {}, body: { ok: true } });
    let operationId = '';
    await assert.rejects(authority.execute(request, 'sulla-tools', TOKEN.broker), (error: any) => {
      operationId = error.message; return error.code === 'approval_required';
    });
    const approval = authority.approve('sulla-desktop-approval', TOKEN.approval, operationId);
    assert.equal((await authority.execute({ ...request, approvalId: approval.approvalId }, 'sulla-tools', TOKEN.broker)).status, 200);
    await assert.rejects(authority.execute({ ...request, approvalId: approval.approvalId }, 'sulla-tools', TOKEN.broker), (error: any) => error.code === 'approval_required');
    await assert.rejects(authority.execute({ ...request, claims: { ...request.claims, credential_scope: undefined } }, 'sulla-tools', TOKEN.broker),
      (error: any) => error.code === 'policy_denied');

    const oauthItem: any = await authority.revealHumanItem(unlocked.sessionId, unlocked.csrf, listed[0].id as string);
    oauthItem.item.agentPolicy.askFirst = false;
    oauthItem.item.integration.properties.refresh_token = 'same-refresh-token';
    oauthItem.item.integration.properties.access_token = 'same-access-token';
    oauthItem.item.integration.properties.client_id = 'synthetic-client';
    oauthItem.item.integration.properties.client_secret = 'synthetic-client-secret';
    oauthItem.item.integration.properties.provider_id = 'grok';
    oauthItem.item.integration.properties.account_label = 'Synthetic account';
    oauthItem.item.integration.properties.connection_status = 'true';
    oauthItem.item.integration.properties.base_url = 'https://user:password@api.openai.com/v1?token=secret';
    await authority.saveHumanItem(unlocked.sessionId, unlocked.csrf, oauthItem);
    (authority as any).send = async(_url: URL, _method: string, headers: Record<string, string>, body: unknown) => {
      assert.match(headers.authorization, /^Basic /);
      assert.ok(body instanceof URLSearchParams);
      assert.equal(body.get('refresh_token'), 'same-refresh-token');
      return { status: 200, headers: {}, body: { access_token: 'same-access-token', refresh_token: 'same-refresh-token', expires_in: 3600, token_type: 'Bearer' } };
    };
    await assert.rejects(authority.execute({
      ...request,
      operation: 'oauth.refresh',
      url: 'https://attacker.example/oauth/token',
      responseType: 'json',
      injections: [{ field: 'refresh_token', target: 'form', name: 'refresh_token', scheme: 'raw' }],
    }, 'sulla-tools', TOKEN.broker), (error: any) => error.code === 'destination_denied');
    const oauthResult = await authority.execute({
      ...request,
      operation: 'oauth.refresh',
      url: 'https://auth.x.ai/oauth2/token',
      responseType: 'json',
      injections: [
        { field: 'refresh_token', target: 'form', name: 'refresh_token', scheme: 'raw' },
        { field: 'client_secret', target: 'header', name: 'authorization', scheme: 'BasicClient' },
      ],
    }, 'sulla-tools', TOKEN.broker);
    assert.deepEqual(Object.keys(oauthResult.body as object).sort(), ['expires_at', 'expires_in', 'operation', 'scope', 'token_type', 'updated']);
    const refreshed: any = await authority.revealHumanItem(unlocked.sessionId, unlocked.csrf, listed[0].id as string);
    assert.equal(refreshed.item.integration.properties.refresh_token, 'same-refresh-token');
    assert.equal(refreshed.item.integration.properties.access_token, 'same-access-token');
    assert.notEqual(refreshed.item.integration.properties.expires_at, undefined);
    const metadata = await authority.integrationMetadata('sulla-tools', TOKEN.broker, 'openai');
    assert.equal(metadata.activeAccountId, 'default');
    assert.equal(metadata.accounts[0].accountId, 'default');
    assert.equal(metadata.accounts[0].label, 'Synthetic account');
    assert.equal(metadata.accounts[0].connected, true);
    assert.equal(metadata.accounts[0].credentialRequired, true);
    assert.equal(metadata.accounts[0].active, true);
    assert.ok(metadata.accounts[0].revision >= 1);
    assert.equal(metadata.accounts[0].properties.expires_at, refreshed.item.integration.properties.expires_at);
    assert.equal(metadata.accounts[0].properties.client_id, 'synthetic-client');
    assert.equal(metadata.accounts[0].properties.provider_id, 'grok');
    assert.equal(metadata.accounts[0].properties.base_url, undefined);
    assert.equal(metadata.accounts[0].properties.api_key, undefined);
    assert.equal(metadata.accounts[0].properties.client_secret, undefined);
    assert.equal((await authority.setActiveIntegrationAccount('sulla-tools', TOKEN.broker, 'openai', 'default')).activeAccountId, 'default');

    const robinhoodItem = structuredClone(oauthItem.item);
    robinhoodItem.name = 'Synthetic Robinhood';
    robinhoodItem.integration.integrationId = 'robinhood';
    robinhoodItem.integration.accountId = 'default';
    robinhoodItem.integration.properties = { provider_id: 'robinhood', account_label: 'Synthetic Robinhood' };
    const robinhoodCreated = await authority.saveHumanItem(unlocked.sessionId, unlocked.csrf, { item: robinhoodItem });
    (authority as any).send = async(_url: URL, _method: string, headers: Record<string, string>, body: unknown) => {
      assert.equal(headers['content-type'], 'application/json');
      validateOAuthRegistrationRequest(body);
      return {
        status: 200, headers: {},
        body: { client_id: 'synthetic-public-client', client_secret: 'synthetic-registration-secret', registration_access_token: 'synthetic-registration-token' },
      };
    };
    const registration = await authority.execute({
      ...request,
      claims: { ...request.claims, credential_scope: { integration_id: 'robinhood', account_id: 'default' } },
      operation: 'oauth.register', ref: { integrationId: 'robinhood', accountId: 'default' },
      url: 'https://agent.robinhood.com/oauth/trading/register', method: 'POST',
      body: {
        client_name: 'Sulla Desktop - Robinhood', grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'], token_endpoint_auth_method: 'none',
        redirect_uris: ['http://127.0.0.1:49152/oauth/callback'],
      },
      headers: {}, injections: [], responseType: 'json',
    }, 'sulla-tools', TOKEN.broker);
    assert.deepEqual(registration.body, { updated: true, operation: 'oauth.register', client_id: 'synthetic-public-client' });
    const registered: any = await authority.revealHumanItem(unlocked.sessionId, unlocked.csrf, robinhoodCreated.id);
    assert.equal(registered.item.integration.properties.oauth_client_id, 'synthetic-public-client');
    assert.equal(registered.item.integration.properties.client_secret, 'synthetic-registration-secret');
    assert.equal(registered.item.integration.properties.registration_access_token, 'synthetic-registration-token');
    const robinhoodMetadata = await authority.integrationMetadata('sulla-tools', TOKEN.broker, 'robinhood');
    assert.equal(robinhoodMetadata.accounts[0].properties.oauth_client_id, 'synthetic-public-client');
    assert.equal(robinhoodMetadata.accounts[0].properties.client_secret, undefined);
    assert.equal(robinhoodMetadata.accounts[0].properties.registration_access_token, undefined);

    (authority as any).send = async(_url: URL, _method: string, _headers: Record<string, string>, body: unknown) => {
      assert.ok(body instanceof URLSearchParams);
      assert.equal(body.get('token'), 'same-access-token');
      return { status: 200, headers: {}, body: {} };
    };
    assert.deepEqual((await authority.execute({
      ...request,
      operation: 'oauth.revoke',
      url: 'https://auth.x.ai/oauth2/revoke',
      responseType: 'json',
      injections: [{ field: 'access_token', target: 'form', name: 'token', scheme: 'raw' }],
    }, 'sulla-tools', TOKEN.broker)).body, { revoked: true });
    const revoked: any = await authority.revealHumanItem(unlocked.sessionId, unlocked.csrf, listed[0].id as string);
    assert.equal(revoked.item.integration.properties.access_token, undefined);
    assert.equal(revoked.item.integration.properties.refresh_token, undefined);
    await db.query('INSERT INTO integration_definitions(slug,files) VALUES ($1,$2),($3,$4)', [
      'openai', {
        'openai.v1-auth.yaml': 'api:\n  name: OpenAI\n  version: v1\n  base_url: https://api.openai.com\nauth:\n  type: apiKey\n  header: x-api-key\n',
        'widget.v1.yaml': 'endpoint:\n  name: widget\n  path: /v1/widgets/{id}\n  method: GET\n  auth: required\n',
      },
      'mcp-public', {
        'mcp-public.v1-auth.yaml': 'api:\n  name: Public MCP\n  version: v1\n  base_url: https://mcp.example.com/rpc\n  transport: mcp\nauth:\n  type: bearer\n',
        'call.v1.yaml': 'endpoint:\n  name: call\n  path: /rpc\n  method: POST\n  auth: none\n',
      },
    ]);
    (authority as any).send = async() => ({ status: 200, headers: {}, body: { ok: true } });
    assert.equal((await authority.execute({
      ...request,
      operation: 'catalog.http',
      url: 'https://api.openai.com/v1/widgets/abc',
      method: 'GET',
      body: undefined,
      injections: [{ field: 'api_key', target: 'header', name: 'x-api-key', scheme: 'raw' }],
    }, 'sulla-tools', TOKEN.broker)).status, 200);
    await assert.rejects(authority.execute({
      ...request,
      operation: 'catalog.http',
      url: 'https://api.openai.com/v1/unregistered',
      method: 'GET',
      body: undefined,
      injections: [{ field: 'api_key', target: 'header', name: 'x-api-key', scheme: 'raw' }],
    }, 'sulla-tools', TOKEN.broker), (error: any) => error.code === 'policy_denied');
    const publicMcp = await authority.execute({
      claims: {
        ...request.claims,
        credential_scope: { integration_id: 'mcp', account_id: 'public' },
      },
      operation: 'mcp.http',
      ref: { integrationId: 'mcp', accountId: 'public' },
      url: 'https://mcp.example.com/rpc',
      method: 'POST',
      body: { jsonrpc: '2.0' },
      injections: [],
      responseType: 'json',
    }, 'sulla-tools', TOKEN.broker);
    assert.equal(publicMcp.status, 200);

    authority.lock();
    assert.equal(authority.status().unlocked, false);
    await assert.rejects(authority.listHumanItems(unlocked.sessionId, unlocked.csrf), (error: any) => ['invalid_human_session', 'vault_locked'].includes(error.code));

    const account = await db.query<{ kdf: { password: { salt: string; parameters: { memoryBytes: number; operations: number } } } }>('SELECT kdf FROM users LIMIT 1');
    const master = await deriveMasterKey('synthetic password', account.rows[0].kdf.password.salt, account.rows[0].kdf.password.parameters);
    try {
      const callerId = 'sulla-desktop-bootstrap';
      const clientNonce = randomBytes(32).toString('base64url');
      const challenge = authority.createChallenge(callerId, clientNonce, proof(`challenge:${ callerId }:${ clientNonce }`));
      const sessionKey = createHmac('sha256', TOKEN.bootstrap)
        .update(bootstrapSessionKeyInput(callerId, clientNonce, challenge.serverNonce, challenge.challengeId, challenge.expiresAt)).digest();
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', sessionKey, iv);
      const clear = Buffer.from(JSON.stringify({ masterKey: Buffer.from(master.key).toString('base64url') }));
      const ciphertext = Buffer.concat([cipher.update(clear), cipher.final()]);
      const sealed = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
      const sealedDigest = createHash('sha256').update(sealed).digest('base64url');
      const unlockProof = proof(bootstrapUnlockProofInput(callerId, clientNonce, challenge.serverNonce, challenge.challengeId, challenge.expiresAt, sealedDigest));
      assert.equal((await authority.unlock({ callerId, challengeId: challenge.challengeId, clientProof: unlockProof, sealedUnlock: sealed })).state, 'unlocked');
      await assert.rejects(authority.unlock({ callerId, challengeId: challenge.challengeId, clientProof: unlockProof, sealedUnlock: sealed }),
        (error: any) => error.code === 'invalid_bootstrap_challenge');
      sessionKey.fill(0); clear.fill(0);
    } finally {
      master.key.fill(0);
    }

    authority.lock();
    const nested = await db.query<{ kdf: { password: { salt: string; parameters: { memoryBytes: number; operations: number } } } }>('SELECT kdf FROM users LIMIT 1');
    await db.query('UPDATE users SET kdf=$1', [{ salt: nested.rows[0].kdf.password.salt, parameters: nested.rows[0].kdf.password.parameters }]);
    const legacyGrant = authority.createHumanSession('sulla-desktop-control', TOKEN.control);
    const legacyUnlocked = await authority.unlockHumanSession(legacyGrant.sessionId, legacyGrant.csrf, 'synthetic password');
    assert.equal(legacyUnlocked.phase, 'unlocked');
    assert.equal(authority.status().cacheUpdateRequired, true);
    const cacheCaller = 'sulla-desktop-bootstrap';
    const cacheNonce = randomBytes(32).toString('base64url');
    const cacheChallenge = authority.createCacheUpdateChallenge(
      cacheCaller, cacheNonce, proof(cacheUpdateChallengeProofInput(cacheCaller, cacheNonce)),
    );
    assert.equal(cacheChallenge.serverProof, proof(cacheUpdateServerProofInput(
      cacheCaller, cacheNonce, cacheChallenge.serverNonce, cacheChallenge.challengeId, cacheChallenge.expiresAt,
    )));
    const cacheFetchProof = proof(cacheUpdateFetchProofInput(
      cacheCaller, cacheNonce, cacheChallenge.serverNonce, cacheChallenge.challengeId, cacheChallenge.expiresAt,
    ));
    const cached = authority.fetchCacheUpdate({ callerId: cacheCaller, challengeId: cacheChallenge.challengeId, clientProof: cacheFetchProof });
    const cacheSessionKey = createHmac('sha256', TOKEN.bootstrap).update(cacheUpdateSessionKeyInput(
      cacheCaller, cacheNonce, cacheChallenge.serverNonce, cacheChallenge.challengeId, cacheChallenge.expiresAt,
    )).digest();
    const sealedCache = Buffer.from(cached.sealedMaster, 'base64url');
    const cacheDecipher = createDecipheriv('aes-256-gcm', cacheSessionKey, sealedCache.subarray(0, 12));
    cacheDecipher.setAuthTag(sealedCache.subarray(12, 28));
    const cacheClear = Buffer.concat([cacheDecipher.update(sealedCache.subarray(28)), cacheDecipher.final()]);
    assert.equal(Buffer.from(JSON.parse(cacheClear.toString('utf8')).masterKey, 'base64url').byteLength, 32);
    cacheClear.fill(0); cacheSessionKey.fill(0); sealedCache.fill(0);
    assert.equal(authority.status().cacheUpdateRequired, false);
    assert.throws(() => authority.fetchCacheUpdate({ callerId: cacheCaller, challengeId: cacheChallenge.challengeId, clientProof: cacheFetchProof }),
      (error: any) => error.code === 'invalid_bootstrap_challenge');
    await authority.changeHumanPassword(legacyUnlocked.sessionId, legacyUnlocked.csrf, 'synthetic password', 'synthetic next password');
    const abandonedNonce = randomBytes(32).toString('base64url');
    const abandonedChallenge = authority.createCacheUpdateChallenge(
      cacheCaller, abandonedNonce, proof(cacheUpdateChallengeProofInput(cacheCaller, abandonedNonce)),
    );
    authority.lock();
    assert.equal(authority.status().cacheUpdateRequired, false);
    assert.throws(() => authority.fetchCacheUpdate({
      callerId: cacheCaller,
      challengeId: abandonedChallenge.challengeId,
      clientProof: proof(cacheUpdateFetchProofInput(cacheCaller, abandonedNonce, abandonedChallenge.serverNonce,
        abandonedChallenge.challengeId, abandonedChallenge.expiresAt)),
    }), (error: any) => error.code === 'invalid_bootstrap_challenge');
    const relockGrant = authority.createHumanSession('sulla-desktop-control', TOKEN.control);
    await authority.unlockHumanSession(relockGrant.sessionId, relockGrant.csrf, 'synthetic next password');
    const upgraded = await db.query<{ kdf: { password?: { salt: string } } }>('SELECT kdf FROM users LIMIT 1');
    assert.ok(upgraded.rows[0].kdf.password?.salt);
    await db.query("UPDATE items SET agent_policy=jsonb_set(agent_policy,'{askFirst}','true'::jsonb) WHERE integration_ref='openai/default'");

    const server = http.createServer(createApp(db, config(url.toString()), { localAuthority: authority }));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      const base = `http://127.0.0.1:${ address.port }`;
      const vaultPage = await fetch(`${ base }/vault/`, { redirect: 'manual' });
      assert.equal(vaultPage.status, 200);
      assert.match(vaultPage.headers.get('content-security-policy') ?? '', /default-src 'none'/);
      for (const legacyPath of ['/v1/session', '/v1/broker/credential', '/v1/desktop/bootstrap']) {
        const response = await fetch(`${ base }${ legacyPath }`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        assert.equal(response.status, 404, legacyPath);
      }
      assert.equal((await fetch(`${ base }/v1/human/items`)).status, 401);
      assert.equal((await fetch(`${ base }/v1/human/items`, { headers: { origin: 'https://attacker.invalid' } })).status, 403);
      assert.equal((await fetch(`${ base }/v1/broker/status`)).status, 401);
      const brokerStatus = await fetch(`${ base }/v1/broker/status`, {
        headers: { 'x-sulla-service-id': 'sulla-tools', authorization: `Bearer ${ TOKEN.broker }` },
      });
      assert.equal(brokerStatus.status, 200);
      assert.equal((await brokerStatus.json() as any).principalId, user.rows[0].id);
      const execute = async(body: unknown) => fetch(`${ base }/v1/broker/execute`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-sulla-service-id': 'sulla-tools', authorization: `Bearer ${ TOKEN.broker }` },
        body: JSON.stringify(body),
      });
      const denied = await execute(request);
      assert.equal(denied.status, 428);
      assert.equal(denied.headers.get('x-sulla-vault-error'), 'approval_required');
      const operationId = (await denied.json() as any).operationId;
      const approved = await fetch(`${ base }/v1/broker/approve`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-sulla-service-id': 'sulla-desktop-approval', authorization: `Bearer ${ TOKEN.approval }` },
        body: JSON.stringify({ operationId }),
      });
      assert.equal(approved.status, 200);
      const approvalId = (await approved.json() as any).approvalId;
      assert.equal((await execute({ ...request, approvalId })).status, 200);
      assert.equal((await execute({ ...request, approvalId })).status, 428);

      const minted = await fetch(`${ base }/v1/human/session`, {
        method: 'POST',
        headers: { 'x-sulla-service-id': 'sulla-desktop-control', authorization: `Bearer ${ TOKEN.control }` },
      });
      assert.equal(minted.status, 200);
      const mintedBody: any = await minted.json();
      const fragment = new URL(mintedBody.url).hash.slice(1);
      const exchange = await fetch(`${ base }/v1/human/session/exchange`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://127.0.0.1:30135' },
        body: JSON.stringify({ grant: new URLSearchParams(fragment).get('grant'), csrf: mintedBody.csrf }),
      });
      assert.equal(exchange.status, 200);
      assert.match(exchange.headers.get('set-cookie') ?? '', /; Secure(?:;|$)/);
      const exchangeBody: any = await exchange.json();
      const exchangeCookie = exchange.headers.get('set-cookie')!.split(';')[0];
      const locked = await fetch(`${ base }/v1/human/lock`, {
        method: 'POST',
        headers: { cookie: exchangeCookie, 'x-csrf-token': exchangeBody.csrf, origin: 'https://127.0.0.1:30135' },
      });
      assert.equal(locked.status, 200);
      const lockedBody: any = await locked.json();
      assert.equal(lockedBody.phase, 'pre-unlock');
      const lockedCookie = locked.headers.get('set-cookie')!.split(';')[0];
      const unlockedAgain = await fetch(`${ base }/v1/human/unlock`, {
        method: 'POST',
        headers: { cookie: lockedCookie, 'x-csrf-token': lockedBody.csrf, origin: 'https://127.0.0.1:30135', 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'synthetic next password' }),
      });
      assert.equal(unlockedAgain.status, 200);
      assert.equal((await unlockedAgain.json() as any).phase, 'unlocked');
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  } finally {
    await db.end();
    await admin.query(`DROP SCHEMA ${ schema } CASCADE`);
    await admin.end();
  }
});
