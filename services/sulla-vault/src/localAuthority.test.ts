import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';

import pg from 'pg';
import { deriveMasterKey } from '@sulla/vault-crypto';

import { migrate } from './db.js';
import { createApp } from './app.js';
import { LocalVaultAuthority, LocalVaultError, localAuthorityTestHooks } from './localAuthority.js';
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
    await db.query(`INSERT INTO integration_values(integration_id,account_id,property,value) VALUES ('openai','default','api_key','synthetic-only-secret'),('openai','default','llm_access','autofill')`);
    const authority = new LocalVaultAuthority(db, config(url.toString()));
    const grant = authority.createHumanSession('sulla-desktop-control', TOKEN.control);
    await assert.rejects(authority.unlockHumanSession(grant.sessionId, undefined, 'synthetic password'), (error: any) => error.code === 'invalid_csrf');
    const unlocked = await authority.unlockHumanSession(grant.sessionId, grant.csrf, 'synthetic password');
    assert.equal(unlocked.phase, 'unlocked');
    assert.equal(unlocked.state, 'migration_required');
    assert.throws(() => authority.validateHumanSession(grant.sessionId, grant.csrf), (error: any) => error.code === 'invalid_human_session');
    const first = await authority.migrateLegacy('sulla-desktop-control', TOKEN.control);
    assert.equal(first.imported, 2);
    const legacyBefore = await db.query('SELECT * FROM integration_values ORDER BY value_id');
    const second = await authority.migrateLegacy('sulla-desktop-control', TOKEN.control);
    assert.equal(second.imported, 0);
    assert.equal(second.skipped, 2);
    assert.deepEqual((await db.query('SELECT * FROM integration_values ORDER BY value_id')).rows, legacyBefore.rows);

    const listed = await authority.listHumanItems(unlocked.sessionId, unlocked.csrf);
    const detail: any = await authority.revealHumanItem(unlocked.sessionId, unlocked.csrf, listed[0].id as string);
    detail.item.name = 'Owner edited v2 credential';
    detail.item.agentPolicy.askFirst = true;
    await authority.saveHumanItem(unlocked.sessionId, unlocked.csrf, detail);
    await db.query(`INSERT INTO integration_values(integration_id,account_id,property,value) VALUES ('openai','default','organization','synthetic-org')`);
    const changedSource = await authority.migrateLegacy('sulla-desktop-control', TOKEN.control);
    assert.equal(changedSource.imported, 0);
    const preserved: any = await authority.revealHumanItem(unlocked.sessionId, unlocked.csrf, listed[0].id as string);
    assert.equal(preserved.item.name, 'Owner edited v2 credential');

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
    await authority.saveHumanItem(unlocked.sessionId, unlocked.csrf, oauthItem);
    (authority as any).send = async() => ({
      status: 200, headers: {}, body: { access_token: 'same-access-token', refresh_token: 'same-refresh-token', expires_in: 3600, token_type: 'Bearer' },
    });
    const oauthResult = await authority.execute({
      ...request,
      operation: 'oauth.refresh',
      url: 'https://api.openai.com/oauth/token',
      responseType: 'json',
      injections: [
        { field: 'refresh_token', target: 'json', name: 'refresh_token', scheme: 'raw' },
        { field: 'client_id', target: 'json', name: 'client_id', scheme: 'raw' },
        { field: 'client_secret', target: 'json', name: 'client_secret', scheme: 'raw' },
      ],
    }, 'sulla-tools', TOKEN.broker);
    assert.deepEqual(Object.keys(oauthResult.body as object).sort(), ['expires_at', 'expires_in', 'refreshed', 'scope', 'token_type']);
    const refreshed: any = await authority.revealHumanItem(unlocked.sessionId, unlocked.csrf, listed[0].id as string);
    assert.equal(refreshed.item.integration.properties.refresh_token, 'same-refresh-token');
    assert.equal(refreshed.item.integration.properties.access_token, 'same-access-token');
    assert.notEqual(refreshed.item.integration.properties.expires_at, undefined);

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
      for (const legacyPath of ['/v1/session', '/v1/broker/credential', '/v1/desktop/bootstrap']) {
        const response = await fetch(`${ base }${ legacyPath }`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        assert.equal(response.status, 404, legacyPath);
      }
      assert.equal((await fetch(`${ base }/v1/human/items`)).status, 401);
      assert.equal((await fetch(`${ base }/v1/human/items`, { headers: { origin: 'https://attacker.invalid' } })).status, 403);
      const execute = async(body: unknown) => fetch(`${ base }/v1/broker/execute`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-sulla-service-id': 'sulla-tools', authorization: `Bearer ${ TOKEN.broker }` },
        body: JSON.stringify(body),
      });
      const denied = await execute(request);
      assert.equal(denied.status, 428);
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
