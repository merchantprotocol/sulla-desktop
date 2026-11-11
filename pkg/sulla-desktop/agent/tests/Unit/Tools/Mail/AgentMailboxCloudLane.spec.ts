// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';

import { validateOperation } from '../../../../../../../services/sulla-vault/src/operationPolicy';
import {
  AgentMailboxCloudLane,
  type AgentMailboxCloudEgress,
  type AgentMailboxCloudSession,
} from '../../../../../../../services/sulla-vault/src/sullaCloudSession/AgentMailboxCloudLane';

const HOST = 'sulla-workers.merchantprotocol.workers.dev';
const BASE = `https://${ HOST }`;
const SESSION_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.session-access-token.signature';
const INJECTION = { field: 'access_token', target: 'header' as const, name: 'authorization', scheme: 'Bearer' as const };

class LaneError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message) }
}

class FakeSession implements AgentMailboxCloudSession {
  tokenCalls = 0;
  constructor(public active: string | null = 'user-1') {}
  async activeAccountId() { return this.active }
  async accessToken() { this.tokenCalls++; return { credential: SESSION_TOKEN, item: { id: 'item-1' } } }
}

class FakeEgress implements AgentMailboxCloudEgress {
  readonly sent: { url: string; headers: Record<string, string>; secrets: string[]; body: unknown }[] = [];
  readonly audited: unknown[] = [];
  async send(request: any, target: URL, headers: Record<string, string>, secrets: string[]) {
    this.sent.push({ url: target.toString(), headers, secrets, body: request.body });
    return { status: 200, headers: {}, body: { mailboxes: [] } };
  }
  async audit(_request: unknown, item: unknown) { this.audited.push(item) }
}

const request = (overrides: Record<string, unknown> = {}) => ({
  claims:     { sub: 'u', agent_id: 'opus-worker', pod_id: 'pod-1', credential_scope: { integration_id: 'sulla-cloud', account_id: 'user-1' } },
  operation:  'sulla-cloud.agent-mailboxes.read',
  ref:        { integrationId: 'sulla-cloud', accountId: 'user-1' },
  url:        `${ BASE }/agent-mailboxes`,
  method:     'GET',
  headers:    { accept: 'application/json' },
  injections: [INJECTION],
  responseType: 'json' as const,
  ...overrides,
}) as any;

const lane = (session = new FakeSession(), egress = new FakeEgress()) =>
  ({ lane: new AgentMailboxCloudLane(HOST, session, egress, (code, status, message) => new LaneError(code, status, message)), session, egress });

describe('AgentMailboxCloudLane (vault)', () => {
  it('injects the vault-held Cloud session as Bearer server-side and drops any caller authorization header', async() => {
    // risk: credential custody — the user's session is added inside the vault only; a caller cannot supply or see it.
    const { lane: subject, egress, session } = lane();
    const result = await subject.execute(request({ headers: { accept: 'application/json', Authorization: 'Bearer attacker', cookie: 'x=1' } }));
    expect(result.status).toBe(200);
    expect(session.tokenCalls).toBe(1);
    expect(egress.sent[0].url).toBe(`${ BASE }/agent-mailboxes`);
    expect(egress.sent[0].headers).toEqual({ accept: 'application/json', authorization: `Bearer ${ SESSION_TOKEN }` });
    // Both forms of the token are handed to the response redactor.
    expect(egress.sent[0].secrets).toEqual([SESSION_TOKEN, `Bearer ${ SESSION_TOKEN }`]);
    expect(egress.audited).toEqual([{ id: 'item-1' }]);
    expect(AgentMailboxCloudLane.handles('sulla-cloud.agent-mailboxes.write')).toBe(true);
    expect(AgentMailboxCloudLane.handles('sulla-cloud.api')).toBe(false);
  });

  it('fails closed when signed out or when the signed scope is for another account', async() => {
    // risk: sign-in — sign-out must stop agent mail at once; a stale scope must not borrow the new session.
    const signedOut = lane(new FakeSession(null));
    await expect(signedOut.lane.execute(request())).rejects.toMatchObject({ code: 'credential_field_missing' });
    expect(signedOut.session.tokenCalls).toBe(0);
    expect(signedOut.egress.sent).toHaveLength(0);

    const switched = lane(new FakeSession('user-2'));
    await expect(switched.lane.execute(request())).rejects.toMatchObject({ code: 'credential_field_missing' });

    const foreignScope = lane();
    await expect(foreignScope.lane.execute(request({
      claims: { sub: 'u', agent_id: 'a', pod_id: 'p', credential_scope: { integration_id: 'sulla_agent_mail', account_id: 'user-1' } },
    }))).rejects.toMatchObject({ code: 'policy_denied' });
    expect(foreignScope.session.tokenCalls).toBe(0);
  });

  it('refuses registration, relabel, disable and every non-mailbox Cloud route before touching the session', async() => {
    // risk: RBAC — agents may read and send mail but never create, rename or disable mailboxes or reach other Cloud APIs.
    const denied: [string, string, string][] = [
      ['sulla-cloud.agent-mailboxes.write', 'POST', '/agent-mailboxes'],
      ['sulla-cloud.agent-mailboxes.read', 'PATCH', '/agent-mailboxes/mb1'],
      ['sulla-cloud.agent-mailboxes.read', 'DELETE', '/agent-mailboxes/mb1'],
      ['sulla-cloud.agent-mailboxes.read', 'GET', '/devices'],
      ['sulla-cloud.agent-mailboxes.read', 'GET', '/agent-mail'],
      ['sulla-cloud.agent-mailboxes.write', 'POST', '/shares'],
      ['sulla-cloud.agent-mailboxes.write', 'POST', '/agent-mailboxes/mb1/retry'],
      ['sulla-cloud.agent-mailboxes.read', 'GET', '/agent-mailboxes/availability'],
    ];
    for (const [operation, method, path] of denied) {
      const { lane: subject, session, egress } = lane();
      await expect(subject.execute(request({ operation, method, url: `${ BASE }${ path }` }))).rejects.toBeInstanceOf(LaneError);
      expect(session.tokenCalls).toBe(0);
      expect(egress.sent).toHaveLength(0);
    }
    const { lane: subject } = lane();
    await expect(subject.execute(request({ url: `https://evil.example/agent-mailboxes` }))).rejects.toMatchObject({ code: 'destination_denied' });
    await expect(subject.execute(request({ url: `http://${ HOST }/agent-mailboxes` }))).rejects.toMatchObject({ code: 'destination_denied' });
    await expect(subject.execute(request({ injections: [{ ...INJECTION, field: 'refresh_token' }] }))).rejects.toMatchObject({ code: 'injection_denied' });
    await expect(subject.execute(request({ responseType: 'text' }))).rejects.toMatchObject({ code: 'invalid_operation' });
  });
});

describe('vault caller policy sulla-cloud.agent-mailboxes.*', () => {
  const policy = { sites: [] } as any;
  const check = (operation: string, method: string, path: string) =>
    () => validateOperation(request({ operation, method, url: `${ BASE }${ path }` }), HOST, policy);

  it('allows exactly the contract read routes with GET and the read/send routes with POST', () => {
    // risk: RBAC — the user-session lane must reach only /agent-mailboxes paths, with the methods the contract defines.
    for (const path of ['/agent-mailboxes', '/agent-mailboxes/mb1/messages', '/agent-mailboxes/mb1/messages/m1', '/agent-mailboxes/mb1/wait-for-code', '/agent-mailboxes/mb1/sent']) {
      expect(check('sulla-cloud.agent-mailboxes.read', 'GET', path)).not.toThrow();
    }
    for (const path of ['/agent-mailboxes/mb1/messages/m1/read', '/agent-mailboxes/mb1/send']) {
      expect(check('sulla-cloud.agent-mailboxes.write', 'POST', path)).not.toThrow();
    }
    for (const path of ['/agent-mailboxes/mb1', '/agent-mailboxes/mb1/other', '/agent-mailboxes/mb1/messages/m1/read', '/agent-mailboxes-x', '/agent-mail', '/calls', '/auth/refresh']) {
      expect(check('sulla-cloud.agent-mailboxes.read', 'GET', path)).toThrow('path_denied');
    }
    for (const path of ['/agent-mailboxes', '/agent-mailboxes/mb1', '/agent-mailboxes/mb1/messages', '/agent-mail/send', '/shares']) {
      expect(check('sulla-cloud.agent-mailboxes.write', 'POST', path)).toThrow('path_denied');
    }
    expect(check('sulla-cloud.agent-mailboxes.read', 'POST', '/agent-mailboxes')).toThrow('method_denied');
    expect(check('sulla-cloud.agent-mailboxes.write', 'DELETE', '/agent-mailboxes/mb1/send')).toThrow('method_denied');
    expect(() => validateOperation(request({ ref: { integrationId: 'sulla_agent_mail', accountId: 'default' } }), HOST, policy)).toThrow('integration_denied');
  });
});
