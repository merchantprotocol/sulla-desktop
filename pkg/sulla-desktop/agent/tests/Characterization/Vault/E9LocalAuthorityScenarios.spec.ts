// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
//
// E9 characterization (pre-refactor): end-to-end LocalVaultAuthority scenarios on a real,
// migrated database (PGlite, or SULLA_TEST_DATABASE_URL). Each scenario runs once on the frozen
// legacy copy and once on the current class; step results, errors, every vault table row,
// every upstream request (headers, body, credential injection) and every relay open must match.

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:crypto', async importOriginal => (await import('../../Support/E9Legacy/E9TestDoubles')).E9NodeDeterminism.cryptoModule(await importOriginal<Record<string, unknown>>()));
vi.mock('node:dns', async importOriginal => (await import('../../Support/E9Legacy/E9TestDoubles')).E9FakeUpstream.dnsModule(await importOriginal<Record<string, unknown>>()));
vi.mock('node:https', async importOriginal => (await import('../../Support/E9Legacy/E9TestDoubles')).E9FakeUpstream.httpsModule(await importOriginal<Record<string, unknown>>()));

import { LocalVaultAuthority } from '../../../../../../services/sulla-vault/src/localAuthority';
import { SULLA_CLOUD_HOST } from '../../../../../../services/sulla-vault/src/sullaCloudRelay';
import { LocalVaultAuthority as LegacyLocalVaultAuthority } from '../../Support/E9Legacy/localAuthority.legacy';
import {
  E9_TOKENS, E9_USER_ID, E9Context, E9ScenarioRunner, E9StreamSink, type E9AuthorityConstructor, type E9Step, type E9Transcript,
} from '../../Support/E9Legacy/E9LocalAuthorityEquivalence';
import { E9Clock } from '../../Support/E9Legacy/E9TestDoubles';

const SLOW = 180_000;

/** Builders for the scripted scenarios (inputs only; every result comes from the code under test). */
class E9Scripts {
  static readonly MASTER = Buffer.alloc(32, 0x11);
  static readonly WRONG_MASTER = Buffer.alloc(32, 0x22);
  static readonly NONCE = 'n'.repeat(43);
  static readonly AGENT_POLICY = { mode: 'agents', level: 'autofill', agents: [], sites: ['api.example.test'], expiresAt: null, askFirst: false, allowServerAgents: false };

  static step(name: string, run: (context: E9Context) => unknown): E9Step { return { name, run } }

  static item(context: E9Context, key: string): string { return String(context.memory.get(key) ?? 'missing') }

  static human(context: E9Context) { return [context.sessionId, context.csrf] as const }

  static jwt(payload: Record<string, unknown>): string {
    return [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'), Buffer.from(JSON.stringify(payload)).toString('base64url'), 'signature'].join('.');
  }

  static itemHttp(itemId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      claims: { sub: E9_USER_ID, agent_id: 'research-agent', pod_id: 'pod-1', credential_scope: { item_id: itemId } },
      operation: 'item.http', ref: { itemId }, url: 'https://api.example.test/v1/me?x=1', method: 'GET',
      headers: { accept: 'application/json', 'X-Api-Key': 'spoofed' }, injections: [], ...extra,
    };
  }

  static github(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      claims: { sub: E9_USER_ID, agent_id: 'research-agent', pod_id: 'pod-1', credential_scope: { integration_id: 'github', account_id: 'personal' } },
      operation: 'github.api', ref: { integrationId: 'github', accountId: 'personal' }, url: 'https://api.github.com/user', method: 'GET',
      headers: { accept: 'application/vnd.github+json' }, injections: [{ field: 'token', target: 'header', name: 'authorization', scheme: 'Bearer' }], ...extra,
    };
  }

  static grok(operation: string, url: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      claims: { sub: E9_USER_ID, agent_id: 'sulla-desktop-main', pod_id: 'desktop-main', credential_scope: { integration_id: 'grok', account_id: 'main' } },
      operation, ref: { integrationId: 'grok', accountId: 'main' }, url, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, injections: [], ...extra,
    };
  }

  static async execute(context: E9Context, request: Record<string, unknown>): Promise<unknown> {
    return context.authority.execute(request as never, 'broker', E9_TOKENS.broker);
  }

  /** Unlock, items, agent writes, integrations, broker HTTP, streams, relays, OAuth, Sulla Cloud, lock. */
  static core(): E9Step[] {
    const s = E9Scripts.step;
    return [
      s('status locked', c => c.authority.status()),
      s('setup required', c => c.authority.isSetupRequired()),
      s('bootstrap unlock creates the vault', c => c.bootstrap.unlock(c.authority, E9Scripts.MASTER, E9Scripts.NONCE)),
      s('status unlocked', c => c.authority.status()),
      s('bootstrap unlock wrong key', c => c.bootstrap.unlock(c.authority, E9Scripts.WRONG_MASTER, E9Scripts.NONCE)),
      s('bootstrap unlock again', c => c.bootstrap.unlock(c.authority, E9Scripts.MASTER, E9Scripts.NONCE)),
      s('bootstrap unlock tampered seal', async c => {
        const challenge = c.authority.createChallenge('bootstrap', E9Scripts.NONCE, c.bootstrap.proof(`challenge:bootstrap:${ E9Scripts.NONCE }`));
        return c.authority.unlock({ callerId: 'bootstrap', challengeId: challenge.challengeId, clientProof: 'bad', sealedUnlock: 'AAAA' });
      }),
      s('setup no longer required', c => c.authority.isSetupRequired()),
      s('with unlocked user key', c => c.authority.withUnlockedUserKey(async keys => ({ userId: keys.userId, userKey: Buffer.from(keys.userKey).toString('hex') }))),
      s('with unlocked identity', c => c.authority.withUnlockedIdentity(async identity => ({ principalId: identity.principalId, publicKey: identity.publicKey, generation: identity.generation }))),
      s('human session', c => c.remember(c.authority.createHumanSession('control', E9_TOKENS.control))),
      s('save item A', async c => {
        const result = await c.authority.saveHumanItem(...E9Scripts.human(c), { item: {
          type: 'login', name: 'Example API', username: 'svc', password: 'pw-secret-1', uris: [{ uri: 'https://api.example.test' }], agentPolicy: E9Scripts.AGENT_POLICY,
          proxy: { hosts: ['api.example.test'], rules: [{ source: 'password', target: 'header', name: 'X-Api-Key', scheme: 'raw' }] },
          customFields: [{ id: 'e9c00000-0000-4000-8000-000000000001', label: 'region', type: 'text', value: 'us-east-1' }],
        } as never });
        c.memory.set('A', result.id);
        return result;
      }),
      s('save item without policy', c => c.authority.saveHumanItem(...E9Scripts.human(c), { item: { type: 'login', name: 'x' } as never })),
      s('save item with bad policy', c => c.authority.saveHumanItem(...E9Scripts.human(c), { item: { type: 'login', name: 'x', agentPolicy: { ...E9Scripts.AGENT_POLICY, level: 'root' } } as never })),
      s('save item with bad proxy', c => c.authority.saveHumanItem(...E9Scripts.human(c), { item: { type: 'login', name: 'x', agentPolicy: E9Scripts.AGENT_POLICY, proxy: { hosts: [], rules: [] } } as never })),
      s('update item A', c => c.authority.saveHumanItem(...E9Scripts.human(c), { id: E9Scripts.item(c, 'A'), revision: 1, item: {
        type: 'login', name: 'Example API v2', username: 'svc', password: 'pw-secret-1', agentPolicy: E9Scripts.AGENT_POLICY,
        proxy: { hosts: ['api.example.test'], rules: [{ source: 'password', target: 'header', name: 'X-Api-Key', scheme: 'raw' }] },
        customFields: [{ id: 'e9c00000-0000-4000-8000-000000000001', label: 'region', type: 'future-type', value: 'eu' }],
      } as never })),
      s('update item A stale revision', c => c.authority.saveHumanItem(...E9Scripts.human(c), { id: E9Scripts.item(c, 'A'), revision: 1, item: { type: 'login', name: 'stale', agentPolicy: E9Scripts.AGENT_POLICY } as never })),
      s('update item A without revision', c => c.authority.saveHumanItem(...E9Scripts.human(c), { id: E9Scripts.item(c, 'A'), item: { type: 'login', name: 'stale', agentPolicy: E9Scripts.AGENT_POLICY } as never })),
      s('save item B (ask first)', async c => {
        const result = await c.authority.saveHumanItem(...E9Scripts.human(c), { item: {
          type: 'login', name: 'Ask API', password: 'ask-secret', agentPolicy: { ...E9Scripts.AGENT_POLICY, askFirst: true },
          proxy: { hosts: ['api.example.test'], rules: [{ source: 'password', target: 'header', name: 'Authorization', scheme: 'Bearer' }] },
        } as never });
        c.memory.set('B', result.id);
        return result;
      }),
      s('list human items', c => c.authority.listHumanItems(...E9Scripts.human(c))),
      s('reveal item A', c => c.authority.revealHumanItem(...E9Scripts.human(c), E9Scripts.item(c, 'A'))),
      s('reveal unknown item', c => c.authority.revealHumanItem(...E9Scripts.human(c), 'e9d00000-0000-4000-8000-000000000009')),
      s('item activity', async c => (await c.authority.listHumanItemActivity(...E9Scripts.human(c), E9Scripts.item(c, 'A')))
        .map(({ id: _id, ...row }) => row).sort((left, right) => String(left.action).localeCompare(String(right.action)))),
      s('delete item B wrong revision', c => c.authority.deleteHumanItem(...E9Scripts.human(c), E9Scripts.item(c, 'B'), 9)),
      s('bitwarden preview', c => c.authority.previewBitwardenImport(...E9Scripts.human(c), { format: 'json', content: JSON.stringify({ encrypted: false, folders: [], items: [
        { id: 'bw-1', type: 1, name: 'BW Login', login: { username: 'bw-user', password: 'bw-pass', uris: [{ uri: 'https://bw.example.test' }] } },
        { id: 'bw-2', type: 2, name: 'BW Note', notes: 'secret note', secureNote: { type: 0 } },
      ] }) })),
      s('bitwarden import', c => c.authority.importBitwarden(...E9Scripts.human(c), { format: 'json', content: JSON.stringify({ encrypted: false, folders: [], items: [
        { id: 'bw-1', type: 1, name: 'BW Login', login: { username: 'bw-user', password: 'bw-pass', uris: [{ uri: 'https://bw.example.test' }] } },
      ] }) })),
      s('bitwarden import duplicate', c => c.authority.importBitwarden(...E9Scripts.human(c), { format: 'json', content: JSON.stringify({ encrypted: false, folders: [], items: [
        { id: 'bw-1', type: 1, name: 'BW Login', login: { username: 'bw-user', password: 'bw-pass', uris: [{ uri: 'https://bw.example.test' }] } },
      ] }) })),
      s('bitwarden bad content', c => c.authority.importBitwarden(...E9Scripts.human(c), { format: 'json', content: '{not json' })),
      s('agent creates item', async c => {
        const result = await c.authority.createAgentVaultItem('broker', E9_TOKENS.broker, { claims: c.claims(), title: ' Agent Login ', generate: true, url: 'https://site.example.test/login', tags: ['a', 2, ''], username: 'bot' } as never);
        c.memory.set('agentItem', result.itemId);
        return result;
      }),
      s('agent create with password and generate', c => c.authority.createAgentVaultItem('broker', E9_TOKENS.broker, { claims: c.claims(), title: 'x', generate: true, password: 'p' } as never)),
      s('agent create for another principal', c => c.authority.createAgentVaultItem('broker', E9_TOKENS.broker, { claims: c.claims({ sub: 'e9e00000-0000-4000-8000-000000000001' }), title: 'x', generate: true } as never)),
      s('agent updates own item', c => c.authority.updateAgentVaultItem('broker', E9_TOKENS.broker, { claims: c.claims(), itemId: E9Scripts.item(c, 'agentItem'), password: 'agent-pass', notes: 'n', tags: ['t'] } as never)),
      s('other agent cannot update', c => c.authority.updateAgentVaultItem('broker', E9_TOKENS.broker, { claims: c.claims({ agent_id: 'other-agent' }), itemId: E9Scripts.item(c, 'agentItem'), password: 'x' } as never)),
      s('agent update bad item id', c => c.authority.updateAgentVaultItem('broker', E9_TOKENS.broker, { claims: c.claims(), itemId: 'nope', password: 'x' } as never)),
      s('agent sets integration credential (new)', c => c.authority.setAgentIntegrationCredential('broker', E9_TOKENS.broker, { claims: c.claims(), integrationId: 'github', accountId: 'agent', property: 'token', value: 'ghp_agent_1' } as never)),
      s('agent sets integration credential (update)', c => c.authority.setAgentIntegrationCredential('broker', E9_TOKENS.broker, { claims: c.claims(), integrationId: 'github', accountId: 'agent', property: 'token', value: 'ghp_agent_2' } as never)),
      s('other agent cannot set credential', c => c.authority.setAgentIntegrationCredential('broker', E9_TOKENS.broker, { claims: c.claims({ agent_id: 'other-agent' }), integrationId: 'github', accountId: 'agent', property: 'token', value: 'x' } as never)),
      s('import github personal', c => c.authority.importDesktopIntegrationAccount('approval', E9_TOKENS.approval, 'github', { accountId: 'personal', values: { token: 'ghp_personal_secret', account_label: 'Me' } } as never)),
      s('import openai work', c => c.authority.importDesktopIntegrationAccount('approval', E9_TOKENS.approval, 'openai', { accountId: 'work', label: ' Work ', connected: true, values: { api_key: 'sk-work-secret', base_url: 'https://api.openai.com/v1', model: 'gpt' } } as never)),
      s('import custom local', c => c.authority.importDesktopIntegrationAccount('approval', E9_TOKENS.approval, 'custom', { accountId: 'local', values: { api_key: 'sk-custom', base_url: 'https://llm.example.test/v1', gateway_url: 'https://gw.example.test/path?q=1' } } as never)),
      s('import vertex region', c => c.authority.importDesktopIntegrationAccount('approval', E9_TOKENS.approval, 'vertex-ai', { accountId: 'gcp', values: { api_key: 'vx', region: 'us-central1' } } as never)),
      s('update openai work', c => c.authority.importDesktopIntegrationAccount('approval', E9_TOKENS.approval, 'openai', { accountId: 'work', label: 'Work 2', active: false, connected: false, values: { api_key: 'sk-work-rotated' } } as never)),
      s('import slack', c => c.authority.importDesktopIntegrationAccount('approval', E9_TOKENS.approval, 'slack', { accountId: 'main', values: { app_token: 'xapp-secret-1' } } as never)),
      s('import s3 backup', c => c.authority.importDesktopIntegrationAccount('approval', E9_TOKENS.approval, 's3-backup', { accountId: 'main', values: { backup_kind: 's3', backup_target: 's3://bucket/path', accessKeyId: 'AKIAE9', secretAccessKey: 'SECRETE9' } } as never)),
      s('integration metadata github', c => c.authority.integrationMetadata('broker', E9_TOKENS.broker, 'github')),
      s('integration metadata openai', c => c.authority.integrationMetadata('broker', E9_TOKENS.broker, 'openai')),
      s('integration metadata custom filtered', c => c.authority.integrationMetadata('broker', E9_TOKENS.broker, 'custom', 'local')),
      s('set active openai work', c => c.authority.setActiveIntegrationAccount('broker', E9_TOKENS.broker, 'openai', 'work')),
      s('set active unknown', c => c.authority.setActiveIntegrationAccount('broker', E9_TOKENS.broker, 'openai', 'missing')),
      s('ensure grok oauth account', c => c.authority.ensureOAuthAccount('approval', E9_TOKENS.approval, 'grok', { accountId: 'main', label: 'Grok' })),
      s('ensure grok oauth account again', c => c.authority.ensureOAuthAccount('approval', E9_TOKENS.approval, 'grok', { accountId: 'main' })),
      s('backup credentials s3', async c => c.authority.backupCredentials(await c.itemIdFor('s3-backup/main'), 's3', 's3://bucket/path')),
      s('backup credentials wrong target', async c => c.authority.backupCredentials(await c.itemIdFor('s3-backup/main'), 's3', 's3://other')),
      s('backup credentials wrong kind', async c => c.authority.backupCredentials(await c.itemIdFor('s3-backup/main'), 'nas', 's3://bucket/path')),
      s('backup credentials bad id', c => c.authority.backupCredentials('not-a-uuid', 's3', 's3://bucket/path')),
      s('list broker items', c => c.authority.listBrokerItems(c.claims() as never, 'broker', E9_TOKENS.broker)),
      s('list broker items other principal', c => c.authority.listBrokerItems(c.claims({ sub: 'e9e00000-0000-4000-8000-000000000001' }) as never, 'broker', E9_TOKENS.broker)),
      s('item.http request', c => {
        c.upstream.reply('GET api.example.test/v1/me?x=1', { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'a=b', 'x-echo': 'pw-secret-1' }, body: '{"echo":"pw-secret-1","ok":true}' });
        return E9Scripts.execute(c, E9Scripts.itemHttp(E9Scripts.item(c, 'A')));
      }),
      s('item.http wrong host', c => E9Scripts.execute(c, E9Scripts.itemHttp(E9Scripts.item(c, 'A'), { url: 'https://evil.example.test/' }))),
      s('item.http with injections', c => E9Scripts.execute(c, E9Scripts.itemHttp(E9Scripts.item(c, 'A'), { injections: [{ field: 'password', target: 'header', name: 'x', scheme: 'raw' }] }))),
      s('item.http scope mismatch', c => E9Scripts.execute(c, E9Scripts.itemHttp(E9Scripts.item(c, 'A'), { ref: { itemId: E9Scripts.item(c, 'B') } }))),
      s('item.http ask first', async c => {
        try { return await E9Scripts.execute(c, E9Scripts.itemHttp(E9Scripts.item(c, 'B'))) } catch (error) { c.memory.set('digest', (error as Error).message); throw error }
      }),
      s('approve the digest', c => { const approval = c.authority.approve('approval', E9_TOKENS.approval, String(c.memory.get('digest'))); c.memory.set('approvalId', approval.approvalId); return approval }),
      s('approve again is not pending', c => c.authority.approve('approval', E9_TOKENS.approval, String(c.memory.get('digest')))),
      s('item.http approved', c => {
        c.upstream.reply('GET api.example.test/v1/me?x=1', { status: 201, headers: { 'content-type': 'text/plain' }, body: 'Bearer ask-secret accepted' });
        return E9Scripts.execute(c, E9Scripts.itemHttp(E9Scripts.item(c, 'B'), { approvalId: c.memory.get('approvalId') }));
      }),
      s('item.http approval is single use', c => E9Scripts.execute(c, E9Scripts.itemHttp(E9Scripts.item(c, 'B'), { approvalId: c.memory.get('approvalId') }))),
      s('github api', c => {
        c.upstream.reply('GET api.github.com/user', { status: 200, headers: { 'content-type': 'application/json' }, body: '{"login":"octo","token":"ghp_personal_secret"}' });
        return E9Scripts.execute(c, E9Scripts.github());
      }),
      s('github api redirect denied', c => {
        c.upstream.reply('GET api.github.com/repos/o/r', { status: 302, headers: { location: 'https://evil.example.test/' } });
        return E9Scripts.execute(c, E9Scripts.github({ url: 'https://api.github.com/repos/o/r' }));
      }),
      s('github api compressed', c => {
        c.upstream.reply('GET api.github.com/rate_limit', { status: 200, headers: { 'content-encoding': 'gzip' }, body: 'zz' });
        return E9Scripts.execute(c, E9Scripts.github({ url: 'https://api.github.com/rate_limit' }));
      }),
      s('github api bad json', c => {
        c.upstream.reply('GET api.github.com/meta', { status: 200, headers: { 'content-type': 'application/json' }, body: 'not json' });
        return E9Scripts.execute(c, E9Scripts.github({ url: 'https://api.github.com/meta' }));
      }),
      s('github api upstream error text', c => {
        c.upstream.reply('GET api.github.com/emojis', { status: 500, headers: { 'content-type': 'text/plain' }, body: 'boom ghp_personal_secret' });
        return E9Scripts.execute(c, E9Scripts.github({ url: 'https://api.github.com/emojis' }));
      }),
      s('github api post body', c => {
        c.upstream.reply('POST api.github.com/user/repos', { status: 201, headers: { 'content-type': 'application/json' }, body: '{"id":1}' });
        return E9Scripts.execute(c, E9Scripts.github({ url: 'https://api.github.com/user/repos', method: 'post', body: { name: 'r', private: true } }));
      }),
      s('github api private address', c => {
        c.upstream.resolve('api.github.com', [{ address: '10.0.0.7', family: 4 }]);
        return E9Scripts.execute(c, E9Scripts.github({ url: 'https://api.github.com/private' })).finally(() => c.upstream.resolve('api.github.com', [{ address: '140.82.112.6', family: 4 }]));
      }),
      s('github api scope mismatch', c => E9Scripts.execute(c, E9Scripts.github({ ref: { integrationId: 'github', accountId: 'agent' } }))),
      s('github api not https', c => E9Scripts.execute(c, E9Scripts.github({ url: 'http://api.github.com/user' }))),
      s('github git stream', async c => {
        c.upstream.reply('GET github.com/owner/repo.git/info/refs?service=git-upload-pack', { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-advertisement', 'content-length': '12' }, body: '001e# service' });
        const sink = new E9StreamSink();
        await c.authority.executeStream(E9Scripts.github({
          operation: 'github.git', url: 'https://github.com/owner/repo.git/info/refs?service=git-upload-pack', responseType: 'binary-stream',
          headers: { 'x-sulla-git-request-id': 'e9f00000-0000-4000-8000-000000000001' },
          claims: { sub: E9_USER_ID, agent_id: 'research-agent', pod_id: 'pod-1', credential_scope: { integration_id: 'github', account_id: 'personal', repository: 'owner/repo' } },
          injections: [{ field: 'token', target: 'header', name: 'authorization', scheme: 'GitHubBasic' }],
        }) as never, 'broker', E9_TOKENS.broker, sink);
        return sink.events;
      }),
      s('github git stream wrong repository', async c => {
        const sink = new E9StreamSink();
        await c.authority.executeStream(E9Scripts.github({
          operation: 'github.git', url: 'https://github.com/owner/other.git/info/refs?service=git-upload-pack', responseType: 'binary-stream',
          claims: { sub: E9_USER_ID, agent_id: 'research-agent', pod_id: 'pod-1', credential_scope: { integration_id: 'github', account_id: 'personal', repository: 'owner/repo' } },
          injections: [{ field: 'token', target: 'header', name: 'authorization', scheme: 'GitHubBasic' }],
        }) as never, 'broker', E9_TOKENS.broker, sink);
        return sink.events;
      }),
      s('text stream not allowed for github.api', async c => {
        const sink = new E9StreamSink();
        await c.authority.executeStream(E9Scripts.github({ responseType: 'stream' }) as never, 'broker', E9_TOKENS.broker, sink);
        return sink.events;
      }),
      s('slack relay opens', async c => {
        const handle = await c.authority.createRelay({ claims: { sub: E9_USER_ID, agent_id: 'research-agent', pod_id: 'pod-1', credential_scope: { integration_id: 'slack', account_id: 'main' } },
          operation: 'slack.socket-mode', ref: { integrationId: 'slack', accountId: 'main' } } as never, 'broker', E9_TOKENS.broker);
        c.memory.set('relay', handle.relayId);
        return handle;
      }),
      s('relay send', c => c.authority.sendRelay(String(c.memory.get('relay')), { type: 'ack', payload: { envelope_id: 'e1' } }, 'broker', E9_TOKENS.broker)),
      s('relay close', c => c.authority.closeRelay(String(c.memory.get('relay')), 'broker', E9_TOKENS.broker)),
      s('relay send after close', c => c.authority.sendRelay(String(c.memory.get('relay')), { type: 'ack', payload: null }, 'broker', E9_TOKENS.broker)),
      s('oauth exchange stores tokens', c => {
        c.upstream.reply('POST auth.x.ai/oauth2/token', { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ access_token: 'grok-access-1', refresh_token: 'grok-refresh-1', expires_in: 3600, token_type: 'Bearer', scope: 'api' }) });
        return E9Scripts.execute(c, E9Scripts.grok('oauth.exchange', 'https://auth.x.ai/oauth2/token', { body: { grant_type: 'authorization_code', code: 'code-1', code_verifier: 'v' } }));
      }),
      s('oauth refresh rotates tokens', c => {
        c.upstream.reply('POST auth.x.ai/oauth2/token', { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ access_token: 'grok-access-2', expires_in: 60 }) });
        return E9Scripts.execute(c, E9Scripts.grok('oauth.refresh', 'https://auth.x.ai/oauth2/token', { body: { grant_type: 'refresh_token' }, injections: [{ field: 'refresh_token', target: 'form', name: 'refresh_token', scheme: 'raw' }] }));
      }),
      s('oauth refresh upstream rejects', c => {
        c.upstream.reply('POST auth.x.ai/oauth2/token', { status: 400, headers: { 'content-type': 'application/json' }, body: '{"error":"invalid_grant"}' });
        return E9Scripts.execute(c, E9Scripts.grok('oauth.refresh', 'https://auth.x.ai/oauth2/token', { body: { grant_type: 'refresh_token' }, injections: [{ field: 'refresh_token', target: 'form', name: 'refresh_token', scheme: 'raw' }] }));
      }),
      s('oauth wrong destination', c => E9Scripts.execute(c, E9Scripts.grok('oauth.exchange', 'https://auth.example.test/token'))),
      s('integration metadata grok', c => c.authority.integrationMetadata('broker', E9_TOKENS.broker, 'grok')),
      s('oauth revoke clears tokens', c => {
        c.upstream.reply('POST auth.x.ai/oauth2/revoke', { status: 200, headers: { 'content-type': 'application/json' }, body: '{}' });
        return E9Scripts.execute(c, E9Scripts.grok('oauth.revoke', 'https://auth.x.ai/oauth2/revoke', { body: {}, injections: [{ field: 'access_token', target: 'form', name: 'token', scheme: 'raw' }] }));
      }),
      s('adopt sulla cloud session', c => c.authority.adoptSullaCloudSession('approval', E9_TOKENS.approval, {
        userId: 'cloud-user-1', activeContractorId: 'ctr-1', contractors: [{ id: 'ctr-1', name: 'Contractor' }], refreshToken: 'cloud-refresh-1',
        accessToken: E9Scripts.jwt({ sub: 'cloud-user-1', exp: Math.floor(E9Clock.START / 1000) + 3600 }),
      } as never)),
      s('adopt expired cloud session', c => c.authority.adoptSullaCloudSession('approval', E9_TOKENS.approval, {
        userId: 'cloud-user-1', activeContractorId: 'ctr-1', contractors: [], refreshToken: 'r', accessToken: E9Scripts.jwt({ sub: 'cloud-user-1', exp: 1 }),
      } as never)),
      s('adopt unsigned cloud session', c => c.authority.adoptSullaCloudSession('approval', E9_TOKENS.approval, {
        userId: 'cloud-user-1', activeContractorId: 'ctr-1', contractors: [], refreshToken: 'r',
        accessToken: [Buffer.from('{"alg":"none"}').toString('base64url'), Buffer.from('{"sub":"cloud-user-1"}').toString('base64url'), 'x'].join('.'),
      } as never)),
      s('desktop cloud request', c => {
        c.upstream.reply(`GET ${ SULLA_CLOUD_HOST }/cloud-vault-sync/status`, { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' });
        return c.authority.executeDesktopSullaCloudRequest('approval', E9_TOKENS.approval, { method: 'get', path: '/cloud-vault-sync/status', headers: { Accept: 'application/json', Cookie: 'x' } } as never);
      }),
      s('desktop cloud request not allowlisted', c => c.authority.executeDesktopSullaCloudRequest('approval', E9_TOKENS.approval, { method: 'GET', path: '/admin/users' } as never)),
      s('desktop cloud request absolute url', c => c.authority.executeDesktopSullaCloudRequest('approval', E9_TOKENS.approval, { method: 'GET', path: 'https://evil.example.test/cloud-vault-sync/status' } as never)),
      s('migrate legacy (not configured)', c => c.authority.migrateLegacy('control', E9_TOKENS.control)),
      s('rotate account recovery key', c => c.authority.rotateAccountRecoveryKey('approval', E9_TOKENS.approval)),
      s('rotate account recovery key again', c => c.authority.rotateAccountRecoveryKey('approval', E9_TOKENS.approval)),
      s('device approval vault mismatch', c => c.authority.wrapUserKeyForApprovedDevice('approval', E9_TOKENS.approval, { approved: true, vaultId: 'e9b00000-0000-4000-8000-000000000001', vaultEpoch: 1, requestId: 'r', publicKey: 'x' } as never)),
      s('adopt enrollment when vault exists', c => c.authority.adoptVaultEnrollment('approval', E9_TOKENS.approval, { masterKey: E9Scripts.MASTER.toString('base64url') } as never)),
      s('delete item A', c => c.authority.deleteHumanItem(...E9Scripts.human(c), E9Scripts.item(c, 'A'), 2)),
      s('list after delete', c => c.authority.listHumanItems(...E9Scripts.human(c))),
      s('clear sulla cloud session', c => c.authority.clearSullaCloudSession('approval', E9_TOKENS.approval)),
      s('lock', c => c.authority.lock()),
      s('status after lock', c => c.authority.status()),
      s('old human session is gone', c => c.authority.listHumanItems(...E9Scripts.human(c))),
      s('broker after lock', c => E9Scripts.execute(c, E9Scripts.github())),
    ];
  }

  /** Password unlock, cache-update hand-off, password change, recovery, backup export, Cloud ownership metadata. */
  static password(): E9Step[] {
    const s = E9Scripts.step;
    return [
      s('setup required', c => c.authority.isSetupRequired()),
      s('pre-unlock session', c => c.remember(c.authority.createHumanSession('control', E9_TOKENS.control))),
      s('import backup needs a password', c => c.authority.importHumanBackup(...E9Scripts.human(c), '', { version: 1 } as never)),
      s('unlock creates the vault', c => c.remember(c.authority.unlockHumanSession(...E9Scripts.human(c), 'first local password'))),
      s('unlock again is refused', c => c.authority.unlockHumanSession(...E9Scripts.human(c), 'first local password')),
      s('cache update hand-off', c => c.bootstrap.fetchCacheUpdate(c.authority, E9Scripts.NONCE)),
      s('cache update is single use', c => c.bootstrap.fetchCacheUpdate(c.authority, E9Scripts.NONCE)),
      s('change password wrong current', c => c.authority.changeHumanPassword(...E9Scripts.human(c), 'not the password', 'second local password')),
      s('change password missing next', c => c.authority.changeHumanPassword(...E9Scripts.human(c), 'first local password', '')),
      s('change password', c => c.authority.changeHumanPassword(...E9Scripts.human(c), 'first local password', 'second local password')),
      s('cache update after change', c => c.bootstrap.fetchCacheUpdate(c.authority, E9Scripts.NONCE)),
      s('configure recovery too short', c => c.authority.configureHumanRecovery(...E9Scripts.human(c), 'short')),
      s('configure recovery', c => c.authority.configureHumanRecovery(...E9Scripts.human(c), 'RECOVERY-CODE-0001')),
      s('save item', c => c.authority.saveHumanItem(...E9Scripts.human(c), { item: { type: 'login', name: 'Bank', username: 'me', password: 'bank-secret', agentPolicy: { ...E9Scripts.AGENT_POLICY, mode: 'only_me', sites: [] } } as never })),
      s('export backup without password', c => c.authority.exportHumanBackup(...E9Scripts.human(c), '')),
      s('export backup', async c => { const envelope = await c.authority.exportHumanBackup(...E9Scripts.human(c), 'backup password'); c.memory.set('backup', envelope); return envelope }),
      s('cloud ownership recorded', c => c.authority.rewrapForAccountPassword('approval', E9_TOKENS.approval, { cloudUserId: 'cloud-1', masterKey: Buffer.alloc(32, 0x33).toString('base64url'), kdf: { alg: 'argon2id13', salt: 'B'.repeat(22), memoryBytes: 67_108_864, ops: 3 } } as never)),
      s('cloud ownership is kept', c => c.authority.rewrapForAccountPassword('approval', E9_TOKENS.approval, { cloudUserId: 'cloud-1', masterKey: Buffer.alloc(32, 0x33).toString('base64url'), kdf: { alg: 'argon2id13', salt: 'B'.repeat(22), memoryBytes: 67_108_864, ops: 3 } } as never)),
      s('different cloud owner refused', c => c.authority.rewrapForAccountPassword('approval', E9_TOKENS.approval, { cloudUserId: 'cloud-2', masterKey: Buffer.alloc(32, 0x33).toString('base64url'), kdf: { alg: 'argon2id13', salt: 'B'.repeat(22), memoryBytes: 67_108_864, ops: 3 } } as never)),
      s('recover while unlocked is refused', c => c.authority.recoverHumanSession(...E9Scripts.human(c), 'RECOVERY-CODE-0001', 'x')),
      s('lock human session', c => c.remember(c.authority.lockHumanSession(...E9Scripts.human(c)))),
      s('locked different cloud owner refused', c => c.authority.rewrapForAccountPassword('approval', E9_TOKENS.approval, { cloudUserId: 'cloud-2', masterKey: Buffer.alloc(32, 0x33).toString('base64url'), kdf: { alg: 'argon2id13', salt: 'B'.repeat(22), memoryBytes: 67_108_864, ops: 3 } } as never)),
      s('unlock wrong password', c => c.authority.unlockHumanSession(...E9Scripts.human(c), 'wrong password')),
      s('recover wrong code', c => c.authority.recoverHumanSession(...E9Scripts.human(c), 'RECOVERY-CODE-9999', 'third local password')),
      s('recover', c => c.remember(c.authority.recoverHumanSession(...E9Scripts.human(c), 'RECOVERY-CODE-0001', 'third local password'))),
      s('list after recovery', c => c.authority.listHumanItems(...E9Scripts.human(c))),
      s('cache update after recovery', c => c.bootstrap.fetchCacheUpdate(c.authority, E9Scripts.NONCE)),
      s('import backup into unlocked vault', c => c.authority.importHumanBackup(...E9Scripts.human(c), 'backup password', c.memory.get('backup') as never)),
      s('status', c => c.authority.status()),
    ];
  }

  /** Restores an exported backup into an empty vault and unlocks it with the exported password. */
  static restore(envelope: unknown): E9Step[] {
    const s = E9Scripts.step;
    return [
      s('pre-unlock session', c => c.remember(c.authority.createHumanSession('control', E9_TOKENS.control))),
      s('import with wrong password', c => c.authority.importHumanBackup(...E9Scripts.human(c), 'not the backup password', envelope as never)),
      s('import backup', c => c.authority.importHumanBackup(...E9Scripts.human(c), 'backup password', envelope as never)),
      s('import twice is refused', c => c.authority.importHumanBackup(...E9Scripts.human(c), 'backup password', envelope as never)),
      s('setup no longer required', c => c.authority.isSetupRequired()),
      s('unlock restored vault', c => c.remember(c.authority.unlockHumanSession(...E9Scripts.human(c), 'second local password'))),
      s('list restored items', c => c.authority.listHumanItems(...E9Scripts.human(c))),
    ];
  }
}

/** Runs a scenario on both implementations and asserts the transcripts are identical. */
class E9Equivalence {
  static async assertSame(steps: E9Step[]): Promise<E9Transcript> {
    const runner = new E9ScenarioRunner();
    const before = await runner.run(LegacyLocalVaultAuthority as unknown as E9AuthorityConstructor, steps);
    const after = await runner.run(LocalVaultAuthority as unknown as E9AuthorityConstructor, steps);
    expect(after.steps).toEqual(before.steps);
    expect(after.upstream).toEqual(before.upstream);
    expect(after.relays).toEqual(before.relays);
    expect(after.tables).toEqual(before.tables);
    return before;
  }
}

afterEach(() => { vi.restoreAllMocks() });

describe.sequential('E9 LocalVaultAuthority scenarios (legacy == current)', () => {
  it('unlock, human items, agent writes, integrations, broker HTTP, streams, relays, OAuth, Sulla Cloud and lock behave identically', async() => {
    // risk: secret disclosure / permissions / data accuracy — the whole local authority surface must not drift.
    const transcript = await E9Equivalence.assertSame(E9Scripts.core());
    // The scenario must really exercise the upstream and relay paths, not fail early everywhere.
    expect(transcript.upstream.length).toBeGreaterThan(5);
    expect(transcript.relays.length).toBeGreaterThan(0);
    expect(transcript.tables.items.length).toBeGreaterThan(5);
  }, SLOW);

  it('password unlock, cache hand-off, password change, recovery, backup and Cloud ownership behave identically', async() => {
    // risk: sign-in / money-grade data loss — key wraps, recovery and backups must be byte-identical.
    const transcript = await E9Equivalence.assertSame(E9Scripts.password());
    const exported = (transcript.steps as Array<{ step: string; ok: boolean }>).find(entry => entry.step === 'export backup');
    expect(exported?.ok).toBe(true);
    // The human session from the async unlock must carry through: these steps must really run, not all fail as 401.
    for (const name of ['change password', 'configure recovery', 'save item']) {
      expect((transcript.steps as Array<{ step: string; ok: boolean }>).find(entry => entry.step === name)).toMatchObject({ ok: true });
    }
  }, SLOW);

  it('restores an exported backup identically', async() => {
    // risk: data loss — a backup made by the old code must restore the same way on the new code.
    const runner = new E9ScenarioRunner();
    const source = await runner.run(LegacyLocalVaultAuthority as unknown as E9AuthorityConstructor, [
      ...E9Scripts.password().slice(0, 16),
      E9Scripts.step('capture backup', c => { (globalThis as { __e9Backup?: unknown }).__e9Backup = c.memory.get('backup'); return 'captured' }),
    ]);
    expect((source.steps as Array<{ step: string; ok: boolean }>).find(entry => entry.step === 'export backup')?.ok).toBe(true);
    const envelope = (globalThis as { __e9Backup?: unknown }).__e9Backup;
    const transcript = await E9Equivalence.assertSame(E9Scripts.restore(envelope));
    expect((transcript.steps as Array<{ step: string; ok: boolean }>).find(entry => entry.step === 'import backup')?.ok).toBe(true);
  }, SLOW);
});
