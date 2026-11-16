// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// The local vault page's browser modules (console/local/app) are plain ES modules with
// no DOM dependency in these classes, so they run under node directly.
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain browser JS module without type declarations
import { VaultApi } from '../console/local/app/VaultApi.js';
// @ts-expect-error plain browser JS module without type declarations
import { AuditEventFormatter } from '../console/local/app/AuditEventFormatter.js';
// @ts-expect-error plain browser JS module without type declarations
import { VaultState } from '../console/local/app/VaultState.js';
// @ts-expect-error plain browser JS module without type declarations
import { VaultFormat } from '../console/local/app/VaultFormat.js';

type Call = { path: string; init: RequestInit & { headers: Headers } };

const recordingFetch = (respond: (call: Call) => Response | Promise<Response>) => {
  const calls: Call[] = [];
  const fetchImpl = async(path: string, init: Call['init']) => { const call = { path, init }; calls.push(call); return respond(call); };
  return { calls, fetchImpl };
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('VaultApi (local vault page client)', () => {
  // risk: security — every /v1/human call must carry the session's CSRF binding.
  it('refuses to send anything before the session has a CSRF binding', async() => {
    const { calls, fetchImpl } = recordingFetch(() => json(200, {}));
    const api = new VaultApi(fetchImpl);
    await expect(api.request('/v1/human/items')).rejects.toThrow('The vault session is missing its CSRF binding');
    api.csrf = 'c1'; api.clear();
    await expect(api.request('/v1/human/items')).rejects.toThrow('missing its CSRF binding');
    expect(calls).toHaveLength(0);
  });

  it('sends JSON posts same-origin with the CSRF header and never follows redirects', async() => {
    const { calls, fetchImpl } = recordingFetch(() => json(200, { id: 'i3' }));
    const api = new VaultApi(fetchImpl); api.csrf = 'c1';
    await expect(api.post('/v1/human/items', { item: { name: 'GitHub' } })).resolves.toEqual({ id: 'i3' });
    const [{ path, init }] = calls;
    expect(path).toBe('/v1/human/items');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"item":{"name":"GitHub"}}');
    expect(init.credentials).toBe('same-origin');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers.get('x-csrf-token')).toBe('c1');
    expect(init.headers.get('content-type')).toBe('application/json');
  });

  it('leaves content-type unset for bodiless GETs and FormData uploads', async() => {
    const { calls, fetchImpl } = recordingFetch(() => json(200, {}));
    const api = new VaultApi(fetchImpl); api.csrf = 'c1';
    await api.request('/v1/human/items');
    await api.request('/v1/human/upload', { method: 'POST', body: new FormData() });
    expect(calls.map(call => call.init.headers.get('content-type'))).toEqual([null, null]);
    expect(calls.map(call => call.init.headers.get('x-csrf-token'))).toEqual(['c1', 'c1']);
  });

  it('reveals an item with an encoded id and an empty JSON body', async() => {
    const { calls, fetchImpl } = recordingFetch(() => json(200, { id: 'a/b', revision: 2, item: {} }));
    const api = new VaultApi(fetchImpl); api.csrf = 'c1';
    await api.revealItem('a/b');
    expect(calls[0].path).toBe('/v1/human/items/a%2Fb/reveal');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body).toBe('{}');
  });

  it('returns null for 204 responses', async() => {
    const { fetchImpl } = recordingFetch(() => new Response(null, { status: 204 }));
    const api = new VaultApi(fetchImpl); api.csrf = 'c1';
    await expect(api.request('/v1/human/items/i1?revision=3', { method: 'DELETE' })).resolves.toBeNull();
  });

  it('surfaces the server message, then the error code, then the status', async() => {
    const bodies = [json(409, { message: 'Revision conflict', error: 'conflict' }), json(403, { error: 'forbidden' }), new Response('not json', { status: 502 })];
    const { fetchImpl } = recordingFetch(() => bodies.shift() as Response);
    const api = new VaultApi(fetchImpl); api.csrf = 'c1';
    await expect(api.request('/v1/human/items')).rejects.toThrow('Revision conflict');
    await expect(api.request('/v1/human/items')).rejects.toThrow('forbidden');
    await expect(api.request('/v1/human/items')).rejects.toThrow('Vault request failed (502)');
  });

  it('turns transport failures into actionable messages', async() => {
    const failures = [Object.assign(new Error('timeout'), { name: 'TimeoutError' }), new TypeError('fetch failed')];
    const api = new VaultApi(async() => { throw failures.shift(); }); api.csrf = 'c1';
    await expect(api.request('/v1/human/session')).rejects.toThrow('The vault did not respond within 30 seconds. Make sure Sulla finished starting, then try again.');
    await expect(api.request('/v1/human/session')).rejects.toThrow('Could not reach the vault. Make sure Sulla finished starting, then try again.');
  });
});

describe('AuditEventFormatter', () => {
  const state = new VaultState(); state.items = [{ id: 'i1', name: 'GitHub' }];
  const format = new AuditEventFormatter(state);

  // risk: security — a blocked agent attempt must never read as a successful use.
  it('labels blocked agent credential use as an attempt, and allowed use as allowed', () => {
    const blocked = { action: 'agent_credential_use', blocked: true, item_id: 'i1', metadata: { agentId: 'bot' } };
    expect([format.action(blocked), format.result(blocked), format.isAgent(blocked)]).toEqual(['Attempted credential use', 'Blocked', true]);
    const allowed = { ...blocked, blocked: false };
    expect([format.action(allowed), format.result(allowed)]).toEqual(['Used credential', 'Allowed']);
  });

  it('labels human actions and resolves item names', () => {
    const reveal = { action: 'human_item_reveal', blocked: false, item_id: 'i1' };
    expect([format.action(reveal), format.result(reveal), format.isAgent(reveal), format.item(reveal), format.where(reveal)]).toEqual(['Revealed item', 'Recorded', false, 'GitHub', 'Desktop vault']);
    expect(format.item({ item_id: 'gone' })).toBe('Deleted or unavailable item');
    expect(format.item({ item_id: null })).toBe('Vault');
    expect(format.action({ action: 'policy_changed' })).toBe('policy changed');
  });
});

describe('VaultFormat.policy', () => {
  // risk: permissions — an item without a stored policy must default to "only me".
  it('defaults missing policy fields to the most restrictive values', () => {
    expect(VaultFormat.policy(undefined)).toEqual({ mode: 'only_me', level: 'metadata', agents: [], sites: [], expiresAt: null, askFirst: false, allowServerAgents: false });
    expect(VaultFormat.policy({ agentPolicy: { mode: 'agents', level: 'autofill' } })).toMatchObject({ mode: 'agents', level: 'autofill', askFirst: false, allowServerAgents: false });
    expect(VaultFormat.sites(' Example.COM, ,api.example.com ')).toEqual(['example.com', 'api.example.com']);
  });
});
