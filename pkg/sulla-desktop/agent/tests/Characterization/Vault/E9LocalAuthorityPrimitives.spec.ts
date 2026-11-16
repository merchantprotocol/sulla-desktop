// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
//
// E9 characterization (pre-refactor): localAuthority.ts pure helpers, identity gates, bootstrap
// challenge, human-session grants and broker validation that need no database. Every case runs
// the frozen legacy copy and the current module with the same deterministic inputs and asserts
// identical results and identical errors (class name, code, status, message, reason).

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:crypto', async importOriginal => (await import('../../Support/E9Legacy/E9TestDoubles')).E9NodeDeterminism.cryptoModule(await importOriginal<Record<string, unknown>>()));
vi.mock('node:dns', async importOriginal => (await import('../../Support/E9Legacy/E9TestDoubles')).E9FakeUpstream.dnsModule(await importOriginal<Record<string, unknown>>()));
vi.mock('node:https', async importOriginal => (await import('../../Support/E9Legacy/E9TestDoubles')).E9FakeUpstream.httpsModule(await importOriginal<Record<string, unknown>>()));

import * as current from '../../../../../../services/sulla-vault/src/localAuthority';
import * as legacy from '../../Support/E9Legacy/localAuthority.legacy';
import { E9_TOKENS, E9_USER_ID, E9BootstrapClient, E9Normalizer, E9RelayManagerDouble } from '../../Support/E9Legacy/E9LocalAuthorityEquivalence';
import { E9Clock, E9FakeUpstream, E9NodeDeterminism } from '../../Support/E9Legacy/E9TestDoubles';

type Module = typeof current;
type Authority = current.LocalVaultAuthority;

/** Runs the same closure against both modules under identical determinism and compares the outcomes. */
class E9DualRun {
  /** The fixed clock of the run in progress (steps may advance it). */
  static clock = new E9Clock();

  static async same<T>(run: (module: Module) => T | Promise<T>): Promise<unknown> {
    const before = await E9DualRun.outcome(legacy as unknown as Module, run);
    const after = await E9DualRun.outcome(current, run);
    expect(after).toEqual(before);
    return before;
  }

  private static async outcome<T>(module: Module, run: (module: Module) => T | Promise<T>): Promise<unknown> {
    const determinism = E9NodeDeterminism.shared();
    const clock = new E9Clock();
    E9DualRun.clock = clock;
    determinism.reset();
    determinism.enabled = true;
    E9FakeUpstream.shared().reset();
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
    try {
      return { ok: true, value: E9Normalizer.value(await run(module)) };
    } catch (error) {
      return { ok: false, error: E9Normalizer.error(error) };
    } finally {
      now.mockRestore();
      determinism.enabled = false;
    }
  }

  /** Runs a sequence of steps on one authority and records each step's outcome (errors don't stop the script). */
  static script(steps: Array<[string, (authority: Authority, memory: Map<string, unknown>) => unknown]>, config: Record<string, unknown> = {}) {
    return async(module: Module) => {
      const authority = new module.LocalVaultAuthority({} as never, E9DualRun.config(config) as never, new E9RelayManagerDouble());
      const memory = new Map<string, unknown>();
      const log: unknown[] = [];
      for (const [name, step] of steps) {
        try { log.push({ name, ok: true, value: E9Normalizer.value(await step(authority, memory)) }) } catch (error) { log.push({ name, ok: false, error: E9Normalizer.error(error) }) }
      }
      return log;
    };
  }

  static config(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      mode: 'desktop', port: 0, databaseUrl: 'postgresql://synthetic/unused', extensionOrigins: [], auditSpoolDir: '/tmp/e9-local-authority-primitives',
      bootstrapServiceId: 'bootstrap', bootstrapServiceToken: E9_TOKENS.bootstrap, controlServiceId: 'control', controlServiceToken: E9_TOKENS.control,
      approvalServiceId: 'approval', approvalServiceToken: E9_TOKENS.approval, brokerServiceId: 'broker', brokerServiceToken: E9_TOKENS.broker,
      filesServiceId: 'files', filesServiceToken: E9_TOKENS.files, ...extra,
    };
  }

  static jwt(payload: Record<string, unknown>): string {
    return [Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url'), Buffer.from(JSON.stringify(payload)).toString('base64url'), 'sig'].join('.');
  }
}

afterEach(() => { vi.restoreAllMocks() });

describe('E9 localAuthority pure helpers (legacy == current)', () => {
  it('allowlists exactly the same Sulla Cloud desktop paths and methods', async() => {
    // risk: permissions — a widened allowlist lets Desktop reach Cloud endpoints with the owner token.
    const cases: Array<[string, string]> = [
      ['POST', '/usage/byo-events'], ['GET', '/usage/byo-events'], ['POST', '/devices/register'], ['POST', '/devices/heartbeat'], ['GET', '/devices/register'],
      ['POST', '/desktop-channel/tickets'], ['PUT', '/desktop-sync/abc/vault'], ['DELETE', '/desktop-sync/abc/conversations'], ['GET', '/desktop-sync/abc/vault'],
      ['PUT', '/cloud-runtime/v1/device/workflows'], ['DELETE', '/cloud-runtime/v1/device/use-cases'], ['PUT', '/cloud-runtime/v1/device/use-cases'], ['DELETE', '/cloud-runtime/v1/device'],
      ['GET', '/cloud-chat-links'], ['POST', '/cloud-chat-links'], ['DELETE', '/cloud-chat-links/abc'], ['POST', '/cloud-chat-links/abc/deltas'],
      ['GET', '/cloud-chat-links/abc/attachments/x.png'], ['GET', '/cloud-chat-links/abc/cloud-results'], ['POST', '/cloud-chat-links/abc/cloud-results/r1/ack'],
      ['POST', '/cloud-chat-links/abc/replies/r1/fail'], ['POST', '/cloud-chat-links/abc/replies/r1/complete'], ['GET', '/cloud-usecase-installs/v1/device-installs/pending'],
      ['POST', '/cloud-usecase-installs/v1/device-installs/11111111-2222-3333-4444-555555555555/report'], ['GET', '/cloud-vault-sync/status'],
      ['PUT', '/cloud-vault-sync/vaults/11111111-2222-3333-4444-555555555555'], ['GET', '/cloud-vault-sync/vaults/11111111-2222-3333-4444-555555555555/bundle'],
      ['POST', '/cloud-vault-sync/vaults/11111111-2222-3333-4444-555555555555/commit'], ['GET', '/cloud-vault-sync/enrollment/state'],
      ['POST', '/cloud-vault-sync/vaults/11111111-2222-3333-4444-555555555555/enrollment/requests/11111111-2222-3333-4444-555555555555/confirm'],
      ['GET', '/auth/password/device-approval/requests'], ['POST', '/auth/password/device-approval/requests/11111111-2222-3333-4444-555555555555/respond'],
      ['GET', '/files-sync/v1/collections'], ['GET', '/files-sync/v1/usage'], ['PUT', '/files-sync/v1/collections/11111111-2222-3333-4444-555555555555/keys/1'],
      ['PUT', '/files-sync/v1/collections/11111111-2222-3333-4444-555555555555/keys/0'], ['GET', `/files-sync/v1/collections/11111111-2222-3333-4444-555555555555/chunks/${ 'a'.repeat(64) }`],
      ['PUT', `/files-sync/v1/uploads/11111111-2222-3333-4444-555555555555/chunks/${ 'a'.repeat(64) }`], ['GET', '/super-admin/support/sessions'],
      ['POST', '/super-admin/support/sessions/s1/rpc'], ['PUT', '/cloud-files/v1/catalog/desk-1'], ['POST', '/cloud-files/v1/catalog/desk-1/desktop-requests/r1/link'],
      ['POST', '/shares'], ['PATCH', '/shares/s1'], ['PUT', '/shares/s1/content'], ['GET', '/sync/push'], ['POST', '/sync/pull'], ['GET', '/marketplace/browse'],
      ['POST', '/marketplace/submit-manifest'], ['DELETE', '/marketplace/templates/t1'], ['PUT', '/marketplace/templates/t1/bundle'], ['GET', '/admin/users'], ['GET', '/'],
    ];
    await E9DualRun.same(module => cases.map(([method, path]) => [method, path,
      module.localAuthorityTestHooks.allowsSullaCloudDesktopRequest(method, path), module.localAuthorityTestHooks.allowsByoUsageCloudRequest(method, path)]));
  });

  it('classifies the same addresses as private or public', async() => {
    // risk: SSRF — a private address treated as public lets the broker reach the local network.
    const addresses = ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '172.32.0.1', '192.168.1.1', '100.64.0.1', '100.128.0.1', '169.254.1.1', '8.8.8.8',
      '224.0.0.1', '0.0.0.0', '255.255.255.255', '::1', '::', '::ffff:10.0.0.1', '::ffff:8.8.8.8', '2001:db8::1', '2001:0db8:0:0:0:0:0:1', '2606:4700::1111', 'fe80::1', 'fc00::1',
      '2001:4860:4860::8888', '2001:4860:4860:0:0:0:0:8888', '2001:4860::8888%eth0', '3fff::1', '4000::1', '1:2:3:4:5:6:7:8:9', '::ffff:1.2.3.4.5', 'garbage', ''];
    await E9DualRun.same(module => addresses.map(address => [address, module.localAuthorityTestHooks.privateAddress(address)]));
  });

  it('treats the same stream responses as bodyless', async() => {
    // risk: data accuracy — a body treated as empty is dropped; an empty one treated as textual is refused.
    const cases: Array<[string, number, string | string[] | undefined]> = [['HEAD', 200, undefined], ['GET', 202, undefined], ['GET', 204, undefined], ['GET', 205, undefined],
      ['GET', 304, undefined], ['GET', 200, '0'], ['GET', 200, '10'], ['POST', 201, undefined], ['GET', 200, ['0']]];
    await E9DualRun.same(module => cases.map(([method, status, length]) => module.localAuthorityTestHooks.streamResponseIsBodyless(method, status, length)));
  });

  it('resolves credential fields with the same precedence', async() => {
    // risk: secret disclosure — a different field precedence injects the wrong secret upstream.
    const item = {
      type: 'login', name: 'n', username: 'user-name', password: 'pass-word',
      integration: { integrationId: 'github', accountId: 'main', properties: { token: 'prop-token', username: 'prop-user', access_token: 'prop-access' } },
      fields: [{ name: 'api_key', value: 'field-api-key' }, { name: 'client_id', value: 'field-client' }],
      customFields: [{ id: 'c1', type: 'text', label: 'region', value: 'us-east-1' }, { id: 'c2', type: 'hidden', label: 'api_key', value: 'custom-api-key' }, { id: 'c3', type: 'boolean', label: 'flag', value: true }],
      agentPolicy: { mode: 'agents', level: 'autofill', agents: [], sites: [], expiresAt: null },
    };
    const bare = { type: 'login', name: 'n', password: 'only-password', agentPolicy: item.agentPolicy };
    const fields = ['token', 'username', 'password', 'api_key', 'bearer_token', 'api_token', 'access_token', 'auth_token', 'client_id', 'region', 'flag', 'missing'];
    await E9DualRun.same(module => [item, bare].map(candidate => fields.map(field => [field, module.localAuthorityTestHooks.credentialField(candidate as never, field)])));
  });

  it('computes the same operation digests', async() => {
    // risk: permissions — approval digests must bind the exact request; a changed digest breaks or widens approvals.
    const base = {
      claims: { sub: E9_USER_ID, agent_id: 'a', pod_id: 'p', credential_scope: { integration_id: 'github', account_id: 'main' } },
      operation: 'github.api', ref: { integrationId: 'github', accountId: 'main' }, url: 'https://api.github.com/user', method: 'GET',
      injections: [{ field: 'token', target: 'header', name: 'authorization', scheme: 'Bearer' }],
    };
    const variants = [base, { ...base, headers: { b: '2', a: '1' } }, { ...base, body: { z: [1, { y: 'x', a: null }] } }, { ...base, responseType: 'text' },
      { ...base, bodyEncoding: 'base64', body: 'aGk=' }, { ...base, claims: { pod_id: 'p', agent_id: 'a', sub: E9_USER_ID, credential_scope: { account_id: 'main', integration_id: 'github' } } }];
    await E9DualRun.same(module => variants.map(variant => module.localAuthorityTestHooks.operationDigest(variant as never)));
  });

  it('extracts the same bounded ChatGPT account ids and routes codex requests the same way', async() => {
    // risk: data accuracy — a wrong account id routes Codex traffic to another workspace.
    const claim = 'https://api.openai.com/auth';
    const tokens = [
      DualTokens.jwt({ [claim]: { chatgpt_account_id: 'acct-123' } }), DualTokens.jwt({ [claim]: { chatgpt_account_id: ' padded ' } }),
      DualTokens.jwt({ [claim]: { chatgpt_account_id: 'x'.repeat(201) } }), DualTokens.jwt({ [claim]: [] }), DualTokens.jwt({ other: true }),
      'not-a-jwt', 'a.b', 'a.!!!.c', 42, undefined, `${ 'x'.repeat(70_000) }.y.z`,
    ];
    await E9DualRun.same(module => [
      tokens.map(token => module.extractBoundedChatgptAccountId(token)),
      module.extractBoundedChatgptAccountId(tokens[4], tokens[0]),
      ...[['provider.cli', 'codex', {}], ['provider.cli', 'codex', { chatgpt_account_id: 'preset' }], ['provider.cli', 'openai', {}], ['provider.http', 'codex', {}]]
        .map(([operation, integrationId, extra]) => {
          const plaintext = { type: 'apiKey', name: 'c', agentPolicy: {}, integration: { integrationId, accountId: 'main', properties: { id_token: tokens[0], ...(extra as object) } } };
          module.localAuthorityTestHooks.deriveChatgptAccountRoutingForRequest({ operation, ref: { integrationId } } as never, plaintext as never);
          return plaintext;
        }),
    ]);
  });

  it('redacts streamed secrets identically across chunk boundaries', async() => {
    // risk: secret disclosure — a secret split across chunks must still be redacted.
    const secrets = ['s3cr3t-token', 'a b+c', ''];
    const inputs = [['hello s3cr3t-token world'], ['Bearer s3cr', 't-token tail'], ['xx s3cr3t-tok', 'en yy a%20b%2Bc', ' zz'], ['Token s3cr3t-token'], ['', 'plain'], ['a b+c|Bot s3cr3t-token']];
    await E9DualRun.same(module => inputs.map(chunks => {
      const redactor = new module.localAuthorityTestHooks.StreamingRedactor(secrets);
      return [...chunks.map(chunk => redactor.transform(Buffer.from(chunk)).toString('utf8')), redactor.flush().toString('utf8')];
    }));
  });
});

describe('E9 localAuthority gates that need no database (legacy == current)', () => {
  it('rejects the same misconfigured service credentials at construction', async() => {
    // risk: permissions — a missing or shared service credential must stop the vault from starting.
    const configs = [{}, { bootstrapServiceToken: '' }, { controlServiceToken: 'short' }, { brokerServiceToken: E9_TOKENS.control }, { filesServiceToken: undefined }, { approvalServiceToken: 'é'.repeat(16) }];
    for (const extra of configs) {
      await E9DualRun.same(module => { new module.LocalVaultAuthority({} as never, E9DualRun.config(extra) as never, new E9RelayManagerDouble()); return 'constructed' });
    }
  });

  it('runs the bootstrap challenge and identity gates identically', async() => {
    // risk: sign-in — bootstrap proofs, rate limits and service identities guard the unlock path.
    const client = new E9BootstrapClient(E9_TOKENS.bootstrap);
    const nonce = 'n'.repeat(43);
    await E9DualRun.same(E9DualRun.script([
      ['status locked', authority => authority.status()],
      ['challenge wrong caller', authority => authority.createChallenge('control', nonce, client.proof(`challenge:control:${ nonce }`))],
      ['challenge short nonce', authority => authority.createChallenge('bootstrap', 'short', client.proof('challenge:bootstrap:short'))],
      ['challenge bad proof', authority => authority.createChallenge('bootstrap', nonce, 'bad-proof')],
      ...Array.from({ length: 11 }, (_, index) => [`challenge ${ index + 1 }`, (authority: Authority) => authority.createChallenge('bootstrap', nonce, client.proof(`challenge:bootstrap:${ nonce }`))] as [string, (authority: Authority) => unknown]),
      ['unlock unknown challenge', authority => authority.unlock({ callerId: 'bootstrap', challengeId: 'missing', clientProof: 'x', sealedUnlock: 'AAAA' })],
      ['cache challenge without staged update', authority => authority.createCacheUpdateChallenge('bootstrap', nonce, client.proof(`cache-challenge:bootstrap:${ nonce }`))],
      ['cache fetch unknown', authority => authority.fetchCacheUpdate({ callerId: 'bootstrap', challengeId: 'missing', clientProof: 'x' })],
      ['control identity ok', authority => authority.requireControlIdentity('control', E9_TOKENS.control)],
      ['control identity wrong token', authority => authority.requireControlIdentity('control', E9_TOKENS.approval)],
      ['control identity missing token', authority => authority.requireControlIdentity('control', undefined)],
      ['approval identity ok', authority => authority.requireApprovalIdentity('approval', E9_TOKENS.approval)],
      ['approval identity wrong caller', authority => authority.requireApprovalIdentity('broker', E9_TOKENS.approval)],
      ['broker status', authority => authority.brokerStatus('broker', E9_TOKENS.broker)],
      ['broker status wrong token', authority => authority.brokerStatus('broker', E9_TOKENS.files)],
      ['approve wrong identity', authority => authority.approve('approval', E9_TOKENS.broker, 'op')],
      ['approve not pending', authority => authority.approve('approval', E9_TOKENS.approval, 'op')],
      ['with unlocked user key while locked', authority => authority.withUnlockedUserKey(async() => 'never')],
      ['with unlocked identity while locked', authority => authority.withUnlockedIdentity(async() => 'never')],
      ['backup credentials while locked', authority => authority.backupCredentials('11111111-2222-4333-8444-555555555555', 's3', 's3://bucket')],
      ['lock', authority => authority.lock()],
    ]));
  });

  it('issues, validates, exchanges and rejects human sessions identically', async() => {
    // risk: sign-in — human-session grants and CSRF guard every vault page action.
    await E9DualRun.same(E9DualRun.script([
      ['session wrong control token', authority => authority.createHumanSession('control', E9_TOKENS.broker)],
      ['session bad tab id', authority => authority.createHumanSession('control', E9_TOKENS.control, { tabId: 'bad tab!', origin: 'https://example.test' })],
      ['session bad origin', authority => authority.createHumanSession('control', E9_TOKENS.control, { tabId: 'tab-1', origin: 'not a url' })],
      ['session non-http origin', authority => authority.createHumanSession('control', E9_TOKENS.control, { tabId: 'tab-1', origin: 'ftp://example.test' })],
      ['session origin with path', authority => authority.createHumanSession('control', E9_TOKENS.control, { tabId: 'tab-1', origin: 'https://example.test/path' })],
      ['session with target', (authority, memory) => { const session = authority.createHumanSession('control', E9_TOKENS.control, { tabId: 'tab-1', origin: 'https://example.test' }); memory.set('session', session); return session }],
      ['status', (authority, memory) => { const session = memory.get('session') as { sessionId: string; csrf: string }; return authority.humanSessionStatus(session.sessionId, session.csrf) }],
      ['status bad csrf', (authority, memory) => authority.humanSessionStatus((memory.get('session') as { sessionId: string }).sessionId, 'wrong')],
      ['status missing csrf', (authority, memory) => authority.humanSessionStatus((memory.get('session') as { sessionId: string }).sessionId, undefined)],
      ['status unknown session', authority => authority.humanSessionStatus('missing', 'csrf')],
      ['status no session', authority => authority.humanSessionStatus(undefined, 'csrf')],
      ['validate', (authority, memory) => { const session = memory.get('session') as { sessionId: string; csrf: string }; return authority.validateHumanSession(session.sessionId, session.csrf) }],
      ['exchange', (authority, memory) => { const session = memory.get('session') as { sessionId: string; csrf: string }; const next = authority.exchangeHumanGrant(session.sessionId, session.csrf); memory.set('next', next); return next }],
      ['old grant is gone', (authority, memory) => { const session = memory.get('session') as { sessionId: string; csrf: string }; return authority.humanSessionStatus(session.sessionId, session.csrf) }],
      ['list items before unlock', (authority, memory) => { const next = memory.get('next') as { sessionId: string; csrf: string }; return authority.listHumanItems(next.sessionId, next.csrf) }],
      ['save item before unlock', (authority, memory) => { const next = memory.get('next') as { sessionId: string; csrf: string }; return authority.saveHumanItem(next.sessionId, next.csrf, { item: { type: 'login', name: 'x' } as never }) }],
      ['bitwarden preview before unlock', (authority, memory) => { const next = memory.get('next') as { sessionId: string; csrf: string }; return authority.previewBitwardenImport(next.sessionId, next.csrf, { content: '{}', format: 'json' }) }],
      ['unlock with empty password', (authority, memory) => { const next = memory.get('next') as { sessionId: string; csrf: string }; return authority.unlockHumanSession(next.sessionId, next.csrf, '') }],
      ['expired session', (authority, memory) => {
        const next = memory.get('next') as { sessionId: string; csrf: string };
        E9DualRun.clock.advance(16 * 60_000);
        return authority.humanSessionStatus(next.sessionId, next.csrf);
      }],
    ]));
  });

  it('validates broker requests and relay commands identically before touching storage', async() => {
    // risk: permissions — malformed broker identities and scopes must be refused the same way.
    const claims = { sub: E9_USER_ID, agent_id: 'agent', pod_id: 'pod', credential_scope: { integration_id: 'github', account_id: 'main' } };
    const request = { claims, operation: 'github.api', ref: { integrationId: 'github', accountId: 'main' }, url: 'https://api.github.com/user', method: 'GET', injections: [] };
    const cases: Array<[string, unknown]> = [
      ['bad operation', { ...request, operation: '!' }], ['bad sub', { ...request, claims: { ...claims, sub: 'nope' } }], ['bad agent', { ...request, claims: { ...claims, agent_id: '' } }],
      ['bad org', { ...request, claims: { ...claims, org_id: 'x' } }], ['bad thread', { ...request, claims: { ...claims, thread_id: '#' } }], ['item ref outside item.http', { ...request, ref: { itemId: '11111111-2222-4333-8444-555555555555' } }],
      ['scope with item id', { ...request, claims: { ...claims, credential_scope: { integration_id: 'github', account_id: 'main', item_id: '11111111-2222-4333-8444-555555555555' } } }],
      ['bad repository scope', { ...request, operation: 'item.http', claims: { ...claims, credential_scope: { repository: '#' } } }], ['missing ref', { ...request, ref: undefined }],
      ['missing injections', { ...request, injections: undefined }], ['stream on execute', { ...request, responseType: 'stream' }], ['base64 outside files', { ...request, responseType: 'base64' }],
      ['locked vault', request], ['null input', null],
    ];
    await E9DualRun.same(E9DualRun.script([
      ...cases.map(([name, input]) => [`execute ${ name }`, (authority: Authority) => authority.execute(input as never, 'broker', E9_TOKENS.broker)] as [string, (authority: Authority) => unknown]),
      ['execute wrong broker token', authority => authority.execute(request as never, 'broker', E9_TOKENS.files)],
      ['stream locked', authority => authority.executeStream(request as never, 'broker', E9_TOKENS.broker, { start() {}, write: () => true, onceDrain() {}, end() {}, destroy() {}, onAbort() {} })],
      ['list items bad claims', authority => authority.listBrokerItems({ sub: 'x' } as never, 'broker', E9_TOKENS.broker)],
      ['list items locked', authority => authority.listBrokerItems(claims as never, 'broker', E9_TOKENS.broker)],
      ['list items wrong token', authority => authority.listBrokerItems(claims as never, 'files', E9_TOKENS.broker)],
      ['create relay unknown operation', authority => authority.createRelay({ claims, operation: 'irc.socket', ref: { integrationId: 'irc', accountId: 'main' } } as never, 'broker', E9_TOKENS.broker)],
      ['create cloud relay bad params', authority => authority.createRelay({ claims, operation: 'sulla-cloud.relay', ref: { integrationId: 'sulla-cloud', accountId: 'main' }, params: { bad: true } } as never, 'broker', E9_TOKENS.broker)],
      ['send relay unknown', authority => authority.sendRelay('missing', { type: 'x', payload: null }, 'broker', E9_TOKENS.broker)],
      ['events relay unknown', authority => authority.relayEvents('missing', 'broker', E9_TOKENS.broker, new AbortController().signal)],
      ['close relay unknown', authority => authority.closeRelay('missing', 'broker', E9_TOKENS.broker)],
      ['agent item write bad claims', authority => authority.createAgentVaultItem('broker', E9_TOKENS.broker, { claims: { sub: 'x' } } as never)],
      ['agent item write locked', authority => authority.createAgentVaultItem('broker', E9_TOKENS.broker, { claims, title: 't', generate: true } as never)],
      ['integration credential bad ref', authority => authority.setAgentIntegrationCredential('broker', E9_TOKENS.broker, { claims, integrationId: 'bad id', property: 'token', value: 'v' } as never)],
      ['integration metadata bad id', authority => authority.integrationMetadata('broker', E9_TOKENS.broker, 'bad id')],
      ['integration metadata locked', authority => authority.integrationMetadata('broker', E9_TOKENS.broker, 'github')],
      ['set active bad ids', authority => authority.setActiveIntegrationAccount('broker', E9_TOKENS.broker, 'github', 'bad id')],
      ['ensure oauth wrong identity', authority => authority.ensureOAuthAccount('broker', E9_TOKENS.broker, 'grok', { accountId: 'main' })],
      ['ensure oauth not native', authority => authority.ensureOAuthAccount('approval', E9_TOKENS.approval, 'github', { accountId: 'main' })],
      ['ensure oauth bad account', authority => authority.ensureOAuthAccount('approval', E9_TOKENS.approval, 'grok', { accountId: 'bad id' } as never)],
      ['import account bad values', authority => authority.importDesktopIntegrationAccount('approval', E9_TOKENS.approval, 'openai', { accountId: 'main', values: [] } as never)],
      ['import account bad value', authority => authority.importDesktopIntegrationAccount('approval', E9_TOKENS.approval, 'openai', { accountId: 'main', values: { api_key: 1 } } as never)],
      ['adopt cloud session locked', authority => authority.adoptSullaCloudSession('approval', E9_TOKENS.approval, {} as never)],
      ['clear cloud session wrong identity', authority => authority.clearSullaCloudSession('control', E9_TOKENS.control)],
      ['desktop cloud request locked', authority => authority.executeDesktopSullaCloudRequest('approval', E9_TOKENS.approval, { method: 'GET', path: '/cloud-vault-sync/status' } as never)],
      ['migrate wrong identity', authority => authority.migrateLegacy('broker', E9_TOKENS.broker)],
      ['migrate locked', authority => authority.migrateLegacy('control', E9_TOKENS.control)],
      ['rewrap wrong identity', authority => authority.rewrapForAccountPassword('control', E9_TOKENS.control, {} as never)],
      ['rewrap bad cloud user', authority => authority.rewrapForAccountPassword('approval', E9_TOKENS.approval, { cloudUserId: ' ' } as never)],
      ['rewrap bad kdf', authority => authority.rewrapForAccountPassword('approval', E9_TOKENS.approval, { cloudUserId: 'c', kdf: { alg: 'argon2id13', salt: 'short', memoryBytes: 67_108_864, ops: 3 } } as never)],
      ['rewrap bad master key', authority => authority.rewrapForAccountPassword('approval', E9_TOKENS.approval, { cloudUserId: 'c', masterKey: 'short', kdf: { alg: 'argon2id13', salt: 'B'.repeat(22), memoryBytes: 67_108_864, ops: 3 } } as never)],
      ['enrollment wrap not approved', authority => authority.wrapVaultEnrollment('approval', E9_TOKENS.approval, { approved: false } as never)],
      ['enrollment wrap locked', authority => authority.wrapVaultEnrollment('approval', E9_TOKENS.approval, { approved: true } as never)],
      ['enrollment commit unknown', authority => authority.commitVaultEnrollment('approval', E9_TOKENS.approval, 'missing')],
      ['device approval not approved', authority => authority.wrapUserKeyForApprovedDevice('approval', E9_TOKENS.approval, { approved: false } as never)],
      ['device approval locked', authority => authority.wrapUserKeyForApprovedDevice('approval', E9_TOKENS.approval, { approved: true } as never)],
      ['rotate recovery locked', authority => authority.rotateAccountRecoveryKey('approval', E9_TOKENS.approval)],
      ['files audit emit', authority => authority.emitFilesAudit({ subjectKind: 'vault-secret', subjectId: 'x', action: 'a', actor: 'u', result: 'allowed' } as never)],
    ]));
  });
});

/** JWT-shaped test tokens (unsigned payloads; the code under test only decodes them). */
class DualTokens {
  static jwt(payload: Record<string, unknown>): string { return E9DualRun.jwt(payload) }
}
