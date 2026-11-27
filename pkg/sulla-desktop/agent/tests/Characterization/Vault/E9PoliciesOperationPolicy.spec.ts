// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// E9 policies: decision-table equivalence between the verbatim pre-refactor
// operationPolicy.ts (Support/E9Legacy) and the live module path that callers import.
// risk: authorization — a broker operation, host, method, path or credential injection
// that was denied before the OOP move must still be denied, with the same error code.

import { describe, expect, it } from 'vitest';

import type { AgentPolicy } from '@sulla/vault-crypto';
import type { BrokerExecuteRequest, BrokerInjection } from '../../../../../../services/sulla-vault/src/contracts';
import * as live from '../../../../../../services/sulla-vault/src/operationPolicy';
import * as legacy from '../../Support/E9Legacy/operationPolicy.legacy';

type Policy = legacy.BrokerOperationPolicy;
type Outcome = string;

class Outcomes {
  static of(run: () => unknown, table: Readonly<Record<string, unknown>>, operation: string): Outcome {
    try {
      const result = run();
      if (result === undefined) return 'ok:void';
      return result === table[operation] ? 'ok:table-entry' : `ok:other:${ JSON.stringify(result) }`;
    } catch (error) {
      const e = error as Error;
      // TypeErrors from prototype-key lookups carry engine-rendered source text; compare the class only.
      return e instanceof TypeError ? `throw:TypeError` : `throw:${ e.constructor.name }:${ e.message }`;
    }
  }
}

class CaseUniverse {
  readonly hosts: string[];
  readonly injections: BrokerInjection[];
  readonly paths = [
    '/', '/repos/o/r', '/v1/other', '/graphql',
    '/owner/repo.git/info/refs', '/owner/repo/git-upload-pack', '/owner/repo.git/git-receive-pack', '/owner/repo/evil',
    '/api/desktop/sessions', '/api/desktop/sessions/', '/api/desktop/sessions/abc_123', '/api/desktop/sessions/a.b~c-d',
    '/api/desktop/sessions/a%2Fb', '/api/desktop/sessions/a/b',
    '/api/v1/chat/completions', '/api/v1/models', '/inference/v1/chat/completions', '/inference/v1/models',
    '/chat/completions', '/models', '/api/paas/v4/chat/completions', '/api/coding/paas/v4/chat/completions',
    '/api/paas/v4/models', '/api/coding/paas/v4/models', '/v1/chat/completions', '/v1/models', '/v1/chat/completions/x',
    '/inference/chat/completions', '/catalog/models', '/v1/openai/chat/completions', '/v1/openai/models', '/api/tags',
    '/openai/v1/chat/completions', '/openai/v1/models', '/v1/responses', '/v1/responses/compact', '/v1/messages',
    '/v1/messages/count_tokens', '/v1beta/models/gemini-pro:generateContent', '/v1beta/models', '/v1beta/models/a/b:generateContent',
    '/compatible-mode/v1/chat/completions', '/compatible-mode/v1/models', '/compatibility/v1/chat/completions', '/v2/models',
    '/v1/projects/p/locations/us/publishers/google/models/gemini:generateContent', '/backend-api/codex/responses',
    '/backend-api/codex/responses/compact', '/v1/text-to-speech/voice_1/stream', '/v1/text-to-speech/v.1/stream', '/v1/tts',
    '/v1/stt', '/oauth/trading/register', '/oauth/token',
    '/calls', '/calls/c1', '/leads', '/messages', '/devices', '/push/d1', '/agent-mail', '/agent-mail/wait-for-code',
    '/agent-mail/send', '/agent-mail/m1/read', '/agent-mailboxes', '/agent-mailboxes/b1/messages', '/agent-mailboxes/b1/messages/m1',
    '/agent-mailboxes/b1/wait-for-code', '/agent-mailboxes/b1/sent', '/agent-mailboxes/b1/messages/m1/read', '/agent-mailboxes/b1/send',
    '/shares', '/shares/s1', '/shares/s1/content', '/files-sync/v1/collections', '/files-sync/v1/usage',
    '/files-sync/v1/collections/12345678-1234-1234-1234-123456789abc/keys/3',
    `/files-sync/v1/uploads/12345678-1234-1234-1234-123456789abc/chunks/${ 'a'.repeat(64) }`,
    '/cloud-files/v1/catalog/c1', '/cloud-files/v1/catalog/c1/desktop-requests', '/cloud-files/v1/catalog/c1/desktop-requests/r1/content',
    '/cloud-files/v1/catalog/c1/desktop-requests/r1/link', '/cloud-files/v1/catalog/c1/desktop-requests/r1/fail',
  ];

  readonly methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'get', 'post', 'OPTIONS', 'HEAD'];
  readonly responseTypes: (BrokerExecuteRequest['responseType'])[] = [undefined, 'json', 'text', 'stream', 'binary-stream', 'base64'];
  readonly specialOperations = ['unknown.op', '', 'constructor', '__proto__', 'toString', 'hasOwnProperty'];

  constructor(private readonly table: Readonly<Record<string, Policy>>) {
    const hosts = new Set<string>(['evil.example', 'api.openai.com.evil.example', 'sub.api.openai.com', 'example.test', 'login.example.test', 'API.OPENAI.COM']);
    const injections = new Map<string, BrokerInjection>();
    const addInjection = (injection: BrokerInjection) => injections.set(JSON.stringify(injection), injection);
    for (const policy of Object.values(table)) {
      policy.hosts?.forEach(host => hosts.add(host));
      policy.injections.forEach(addInjection);
      for (const binding of policy.bindings ?? []) {
        binding.hosts?.forEach(host => hosts.add(host));
        binding.injections.forEach(addInjection);
        binding.requiredInjections?.forEach(addInjection);
        binding.injectionSets?.forEach(set => set.forEach(addInjection));
      }
    }
    this.hosts = [...hosts];
    const base = [...injections.values()];
    this.injections = [
      ...base,
      { field: 'api_key', target: 'header', name: 'Authorization', scheme: 'Bearer' },
      { field: 'api_key', target: 'header', name: 'X-API-KEY', scheme: 'raw' },
      { field: 'api_key', target: 'header', name: 'x-api-key' },
      { field: 'api_key', target: 'header', name: 'x-api-key', scheme: 'Bearer' },
      { field: 'unknown_field', target: 'header', name: 'authorization', scheme: 'Bearer' },
      { field: 'api_key', target: 'query', name: 'authorization', scheme: 'Bearer' },
    ];
  }

  integrationsFor(operation: string): (string | undefined)[] {
    const policy = this.table[operation];
    const ids = new Set<string | undefined>([undefined, '', 'unknown-integration', 'constructor']);
    policy?.integrations?.forEach(id => ids.add(id));
    policy?.bindings?.forEach(binding => ids.add(binding.integration));
    return [...ids];
  }

  /** One plausible request per binding (or per policy); dimensions are then varied one at a time. */
  seeds(operation: string): { integration: string | undefined; host: string; path: string; method: string; injections: BrokerInjection[]; sites: string[] }[] {
    const policy = this.table[operation];
    const methods = policy?.methods ?? ['GET'];
    const pathFor = (pattern?: RegExp) => (pattern ? this.paths.find(path => pattern.test(path)) : undefined) ?? '/';
    if (policy?.bindings?.length) {
      return policy.bindings.map(binding => ({
        integration: binding.integration,
        host: binding.hosts?.[0] ?? 'example.test',
        path: pathFor(binding.pathPattern ?? policy.pathPattern),
        method: methods[0],
        injections: [...(binding.injectionSets?.[0] ?? binding.requiredInjections ?? binding.injections.slice(0, 1))],
        sites: binding.hosts ? [] : ['example.test'],
      }));
    }
    return (policy?.integrations ?? ['any-integration']).map(integration => ({
      integration,
      host: policy?.hosts?.[0] ?? 'example.test',
      path: pathFor(policy?.pathPattern),
      method: methods[0],
      injections: policy?.injections?.slice(0, 1) ?? [],
      sites: ['example.test'],
    }));
  }
}

class RequestFactory {
  static build(operation: string, integration: string | undefined, host: string, path: string, method: string,
    injections: BrokerInjection[], extra: Partial<BrokerExecuteRequest> = {}): BrokerExecuteRequest {
    return {
      claims: { sub: 'user-1', agent_id: 'agent-1', pod_id: 'pod-1' },
      operation,
      ref: integration === undefined ? {} : { integrationId: integration },
      url: `https://${ host }${ path }`,
      method,
      injections,
      ...extra,
    };
  }

  static itemPolicy(sites: string[]): AgentPolicy {
    return { mode: 'agents', level: 'full', agents: [], sites, expiresAt: null, askFirst: false, allowServerAgents: false } as AgentPolicy;
  }
}

class DecisionTable {
  readonly mismatches: string[] = [];
  readonly seen = new Map<Outcome, number>();

  constructor(private readonly universe: CaseUniverse) {}

  compare(label: string, input: BrokerExecuteRequest, hostname: string, sites: string[]): void {
    const policy = RequestFactory.itemPolicy(sites);
    const before = Outcomes.of(() => legacy.validateOperation(input, hostname, policy), legacy.BROKER_OPERATION_POLICIES, input.operation);
    const after = Outcomes.of(() => live.validateOperation(input, hostname, policy), live.BROKER_OPERATION_POLICIES, input.operation);
    this.seen.set(before, (this.seen.get(before) ?? 0) + 1);
    if (before !== after) this.mismatches.push(`${ label }: legacy=${ before } live=${ after }`);
  }

  run(operation: string): void {
    const u = this.universe;
    for (const seed of u.seeds(operation)) {
      const at = (over: Partial<typeof seed>, extra: Partial<BrokerExecuteRequest> = {}, hostname?: string) => {
        const s = { ...seed, ...over };
        const input = RequestFactory.build(operation, s.integration, s.host, s.path, s.method, s.injections, extra);
        this.compare(`${ operation } ${ JSON.stringify(s) } ${ JSON.stringify(extra) }`, input, hostname ?? s.host, s.sites);
      };
      at({});
      u.integrationsFor(operation).forEach(integration => at({ integration }));
      u.methods.forEach(method => at({ method }));
      u.hosts.forEach(host => { at({ host }); at({ host, sites: [] }); at({ host, sites: [host] }); });
      u.paths.forEach(path => at({ path }));
      u.injections.forEach(injection => at({ injections: [injection] }));
      at({ injections: [] });
      at({ injections: [...seed.injections, ...seed.injections] });
      for (const policy of [legacy.BROKER_OPERATION_POLICIES[operation]]) {
        for (const binding of policy?.bindings ?? []) {
          if (binding.integration !== seed.integration) continue;
          at({ injections: [...binding.injections] });
          binding.injectionSets?.forEach(set => at({ injections: [...set] }));
        }
      }
      [['example.test'], ['*.example.test'], ['other.example'], ['*.openai.com'], ['API.OPENAI.COM'], [seed.host], []].forEach(sites => at({ sites }));
      u.responseTypes.forEach(responseType => at({}, { responseType }));
      at({}, { bodyEncoding: 'base64', body: 'AAAA' });
      at({}, { bodyEncoding: 'base64', body: { not: 'string' } });
      at({}, { bodyEncoding: 'hex' as 'base64', body: 'AAAA' });
      at({}, {}, 'evil.example');
      at({}, {}, seed.host.toUpperCase());
    }
  }
}

const universe = new CaseUniverse(legacy.BROKER_OPERATION_POLICIES);

function liveLegacyComparablePolicies(): typeof live.BROKER_OPERATION_POLICIES {
  const current = live.BROKER_OPERATION_POLICIES['provider.models'];
  if (!current) throw new Error('provider.models policy is missing');
  return {
    ...live.BROKER_OPERATION_POLICIES,
    'provider.models': {
      ...current,
      integrations: current.integrations?.filter(integration => integration !== 'codex'),
      bindings: current.bindings?.filter(binding => binding.integration !== 'codex'),
    },
  };
}

function liveLegacyComparableTrustedOrigins(): typeof live.TRUSTED_INTEGRATION_ORIGINS {
  return Object.fromEntries(Object.entries(live.TRUSTED_INTEGRATION_ORIGINS)
    .filter(([integration]) => integration !== 'clerk'));
}

describe('E9 policies: operationPolicy decision tables (legacy == live)', () => {
  it('keeps the broker operation policy table identical, in the same key order', () => {
    expect(Object.keys(live.BROKER_OPERATION_POLICIES)).toEqual(Object.keys(legacy.BROKER_OPERATION_POLICIES));
    expect(liveLegacyComparablePolicies()).toEqual(legacy.BROKER_OPERATION_POLICIES);
    const trustedOrigins = liveLegacyComparableTrustedOrigins();
    expect(trustedOrigins).toEqual(legacy.TRUSTED_INTEGRATION_ORIGINS);
    expect(Object.keys(trustedOrigins)).toEqual(Object.keys(legacy.TRUSTED_INTEGRATION_ORIGINS));
    expect(live.FILES_SYNC_OPERATION).toBe(legacy.FILES_SYNC_OPERATION);
    expect(live.FILES_SYNC_OPERATION).toBe('sulla-cloud.files-sync');
  });

  it('asserts the approved Codex models binding separately from the frozen legacy table', () => {
    const policy = live.BROKER_OPERATION_POLICIES['provider.models'];
    expect(policy.integrations).toContain('codex');
    expect(policy.bindings?.filter(binding => binding.integration === 'codex')).toEqual([{
      integration: 'codex',
      hosts: ['chatgpt.com'],
      injections: [
        { field: 'access_token', target: 'header', name: 'authorization', scheme: 'Bearer' },
        { field: 'chatgpt_account_id', target: 'header', name: 'chatgpt-account-id', scheme: 'raw' },
      ],
      requiredInjections: [
        { field: 'access_token', target: 'header', name: 'authorization', scheme: 'Bearer' },
        { field: 'chatgpt_account_id', target: 'header', name: 'chatgpt-account-id', scheme: 'raw' },
      ],
      injectionSets: [[
        { field: 'access_token', target: 'header', name: 'authorization', scheme: 'Bearer' },
        { field: 'chatgpt_account_id', target: 'header', name: 'chatgpt-account-id', scheme: 'raw' },
      ]],
      pathPattern: /^\/backend-api\/codex\/models$/,
    }]);
  });

  it('trusts only the Clerk Backend API host as a new integration origin', () => {
    expect(live.TRUSTED_INTEGRATION_ORIGINS.clerk).toEqual(['api.clerk.com']);
    expect(new live.TrustedIntegrationOrigins().originsFor('clerk')).toEqual(['api.clerk.com']);
  });

  for (const operation of [...Object.keys(legacy.BROKER_OPERATION_POLICIES), ...universe.specialOperations]) {
    it(`validateOperation decides ${ JSON.stringify(operation) } identically across every host/method/path/injection/site/response variant`, () => {
      const table = new DecisionTable(universe);
      table.run(operation);
      expect(table.mismatches.slice(0, 20)).toEqual([]);
      expect(table.seen.size).toBeGreaterThan(0);
    });
  }

  it('exercises allow and every deny code across the whole table', () => {
    const table = new DecisionTable(universe);
    for (const operation of [...Object.keys(legacy.BROKER_OPERATION_POLICIES), ...universe.specialOperations]) table.run(operation);
    expect(table.mismatches.slice(0, 20)).toEqual([]);
    const outcomes = [...table.seen.keys()];
    for (const expected of ['ok:table-entry', 'throw:Error:unknown_operation', 'throw:Error:integration_denied', 'throw:Error:method_denied',
      'throw:Error:destination_denied', 'throw:Error:streaming_denied', 'throw:Error:binary_denied', 'throw:Error:path_denied',
      'throw:Error:injection_denied', 'throw:Error:credential_injection_required', 'throw:TypeError']) {
      expect(outcomes).toContain(expected);
    }
  });

  it('pins representative decisions independently of the legacy copy', () => {
    const sites = RequestFactory.itemPolicy([]);
    const bearer = { field: 'api_key', target: 'header' as const, name: 'authorization', scheme: 'Bearer' as const };
    const ok = RequestFactory.build('provider.inference', 'openai', 'api.openai.com', '/v1/chat/completions', 'POST', [bearer]);
    expect(live.validateOperation(ok, 'api.openai.com', sites)).toBe(live.BROKER_OPERATION_POLICIES['provider.inference']);
    expect(() => live.validateOperation(ok, 'evil.example', sites)).toThrow('destination_denied');
    expect(() => live.validateOperation({ ...ok, operation: 'nope' }, 'api.openai.com', sites)).toThrow('unknown_operation');
    expect(() => live.validateOperation({ ...ok, method: 'GET' }, 'api.openai.com', sites)).toThrow('method_denied');
    expect(() => live.validateOperation({ ...ok, url: 'https://api.openai.com/v1/files' }, 'api.openai.com', sites)).toThrow('path_denied');
    expect(() => live.validateOperation({ ...ok, injections: [] }, 'api.openai.com', sites)).toThrow('credential_injection_required');
    expect(() => live.validateOperation({ ...ok, ref: { integrationId: 'github' } }, 'api.openai.com', sites)).toThrow('integration_denied');
    expect(() => live.validateOperation(ok, 'api.openai.com', RequestFactory.itemPolicy(['other.example']))).toThrow('destination_denied');
  });

  it('Slack Web API injects only the bot token (SLACK-1)', () => {
    // risk: credential leak — app-level / Socket Mode tokens must never be injected into slack.com calls.
    const header = (field: string) => ({ field, target: 'header' as const, name: 'authorization', scheme: 'Bearer' as const });
    const sites = RequestFactory.itemPolicy([]);
    const call = (field: string) => RequestFactory.build('slack.web-api', 'slack', 'slack.com', '/api/chat.postMessage', 'POST', [header(field)]);
    expect(live.validateOperation(call('bot_token'), 'slack.com', sites)).toBe(live.BROKER_OPERATION_POLICIES['slack.web-api']);
    for (const field of ['app_token', 'app_level_token', 'scopes_token']) {
      expect(() => live.validateOperation(call(field), 'slack.com', sites), field).toThrow('injection_denied');
    }
    expect(() => live.validateOperation(call('bot_token'), 'evil.example', sites)).toThrow('destination_denied');
  });
});

describe('E9 policies: operationPolicy helpers (legacy == live)', () => {
  const operations = [...Object.keys(legacy.BROKER_OPERATION_POLICIES), ...universe.specialOperations,
    'sulla-cloud.cloud-files.anything', 'sulla-cloud.sharesX', 'sulla-cloud.cloud-files.'];

  it('brokerTransferLimits returns the same caps for every operation', () => {
    for (const operation of operations) {
      expect(live.brokerTransferLimits(operation), operation).toEqual(legacy.brokerTransferLimits(operation));
    }
    expect(live.brokerTransferLimits('sulla-cloud.files-sync')).toEqual({ request: 6 * 1024 * 1024, response: 6 * 1024 * 1024 });
    expect(live.brokerTransferLimits('provider.transcription')).toEqual({ request: 17 * 1024 * 1024, response: 1_048_576 });
    expect(live.brokerTransferLimits('sulla-cloud.shares.content')).toEqual({ request: 25 * 1024 * 1024, response: 1_048_576 });
    expect(live.brokerTransferLimits('github.api')).toEqual({ request: 1_048_576, response: 1_048_576 });
  });

  it('isTrustedFilesCloudCall trusts only Files on its own Sulla Cloud login', () => {
    for (const operation of operations) {
      for (const integrationId of ['sulla-cloud', 'github', undefined]) {
        for (const agent of ['sulla-files', 'other']) {
          for (const pod of ['sulla-files', 'other']) {
            const input = RequestFactory.build(operation, integrationId, 'x.example', '/', 'GET', []);
            input.claims = { sub: 'u', agent_id: agent, pod_id: pod };
            expect(live.isTrustedFilesCloudCall(input), JSON.stringify([operation, integrationId, agent, pod]))
              .toBe(legacy.isTrustedFilesCloudCall(input));
          }
        }
      }
    }
  });

  it('validateItemHttpOperation decides identically for every method/response/encoding/injection combination', () => {
    const mismatches: string[] = [];
    for (const method of universe.methods) {
      for (const responseType of universe.responseTypes) {
        for (const bodyEncoding of [undefined, 'base64'] as const) {
          for (const injections of [[], [{ field: 'api_key', target: 'header', name: 'x', scheme: 'raw' }]] as BrokerInjection[][]) {
            const input = RequestFactory.build('item.http', 'x', 'x.example', '/', method, injections, { responseType, bodyEncoding });
            const before = Outcomes.of(() => legacy.validateItemHttpOperation(input), {}, '');
            const after = Outcomes.of(() => live.validateItemHttpOperation(input), {}, '');
            if (before !== after) mismatches.push(`${ JSON.stringify([method, responseType, bodyEncoding, injections.length]) }: ${ before } vs ${ after }`);
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('trustedOriginsForIntegration returns equal fresh copies (and fails the same way on prototype keys)', () => {
    for (const id of [...Object.keys(legacy.TRUSTED_INTEGRATION_ORIGINS), 'unknown', '', 'constructor', '__proto__', 'toString', 'custom']) {
      const before = Outcomes.of(() => legacy.trustedOriginsForIntegration(id), {}, '');
      const after = Outcomes.of(() => live.trustedOriginsForIntegration(id), {}, '');
      expect(after, id).toBe(before);
      if (!before.startsWith('throw')) expect(live.trustedOriginsForIntegration(id), id).toEqual(legacy.trustedOriginsForIntegration(id));
    }
    const copy = live.trustedOriginsForIntegration('github');
    copy.push('evil.example');
    expect(live.trustedOriginsForIntegration('github')).toEqual(['api.github.com', 'github.com']);
  });
});
