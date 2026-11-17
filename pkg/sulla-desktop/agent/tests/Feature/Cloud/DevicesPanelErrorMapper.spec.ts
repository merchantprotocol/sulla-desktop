// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { DevicesPanelErrorMapper, DevicesRequestFailure, type DevicesPanelWarningSink } from '@pkg/main/cloud/devices/devicesPanelErrorMapper';
import { DevicesPanelError, DevicesPanelService, type DevicesHttp } from '@pkg/main/cloud/devices/DevicesPanelService';

class RecordingSink implements DevicesPanelWarningSink {
  readonly warnings: Array<{ message: string; original: unknown }> = [];
  warn(message: string, original: unknown): void { this.warnings.push({ message, original }) }
}

class VaultBrokerErrorDouble extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = 'VaultBrokerError';
  }
}

function mapperWithSink(): { mapper: DevicesPanelErrorMapper; sink: RecordingSink } {
  const sink = new RecordingSink();

  return { mapper: new DevicesPanelErrorMapper(sink), sink };
}

describe('DevicesPanelErrorMapper', () => {
  it('reports a network failure as cloud_unreachable and keeps the connection message', () => {
    // risk: data accuracy (a real connection failure must not be blamed on the vault)
    const { mapper, sink } = mapperWithSink();
    const failure = mapper.map(new Error('net::ERR_NAME_NOT_RESOLVED'));

    expect(failure).toEqual({ ok: false, code: 'cloud_unreachable', error: 'Couldn\'t reach Sulla Cloud. Check your connection and try again.' });
    expect(sink.warnings).toHaveLength(1);
  });

  it('treats a fetch failure with a refused socket underneath as cloud_unreachable', () => {
    // risk: data accuracy (undici wraps the socket error as `cause`)
    const { mapper } = mapperWithSink();
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' });
    const fetchFailed = Object.assign(new TypeError('fetch failed'), { cause });

    expect(mapper.map(fetchFailed).code).toBe('cloud_unreachable');
  });

  it('treats a timeout as cloud_unreachable', () => {
    // risk: data accuracy (slow network is not a vault refusal)
    const { mapper } = mapperWithSink();

    expect(mapper.map(new Error('The request timed out after 30s')).code).toBe('cloud_unreachable');
  });

  it('maps a policy_denied vault refusal to blocked_by_vault with the update message', () => {
    // risk: permissions (vault policy refusal must be visible, not hidden as a connection error)
    const { mapper } = mapperWithSink();
    const failure = mapper.map(new VaultBrokerErrorDouble('policy_denied', 'Denied by policy', 403));

    expect(failure).toEqual({ ok: false, code: 'blocked_by_vault', error: 'Sulla\'s vault blocked this Cloud request. Update Sulla, and report it if it continues.' });
  });

  it('maps the allowlist refusal message to blocked_by_vault even without a broker code', () => {
    // risk: permissions (the real refusal text from the vault allowlist)
    const { mapper } = mapperWithSink();

    expect(mapper.map(new Error('Sulla Cloud request path or method is not allowlisted')).code).toBe('blocked_by_vault');
  });

  it('keeps a vault refusal ahead of a network-looking message', () => {
    // risk: permissions (a refusal that mentions a connection must still be a refusal)
    const { mapper } = mapperWithSink();

    expect(mapper.map(new VaultBrokerErrorDouble('policy_denied', 'policy denied after connect ECONNRESET', 403)).code).toBe('blocked_by_vault');
  });

  it('maps a Cloud HTTP error answer to cloud_error with the status, through the real service', async() => {
    // risk: data accuracy (the status must reach the user so a Cloud outage reads as Cloud)
    const http: DevicesHttp = { send: async() => ({ status: 503, data: { error: 'unavailable' } }) };
    const service = new DevicesPanelService(http, { get: async() => 'this-device' });
    const { mapper, sink } = mapperWithSink();

    const error = await service.list().then(() => null, (e: unknown) => e);
    const failure = mapper.map(error);

    expect(failure).toEqual({ ok: false, code: 'cloud_error', error: 'Sulla Cloud returned an error (HTTP 503).' });
    expect(sink.warnings[0]?.message).toContain('GET /devices');
    expect(sink.warnings[0]?.original).toBe(error);
  });

  it('logs the method and path of a request that threw before any answer', () => {
    // risk: permissions (the log must show the real refusal for the request that failed)
    const { mapper, sink } = mapperWithSink();
    const vaultRefusal = new VaultBrokerErrorDouble('policy_denied', 'Sulla Cloud request path or method is not allowlisted', 403);

    const failure = mapper.map(new DevicesRequestFailure('DELETE /devices/:id', vaultRefusal));

    expect(failure.code).toBe('blocked_by_vault');
    expect(sink.warnings[0]?.message).toContain('DELETE /devices/:id');
    expect(sink.warnings[0]?.original).toBe(vaultRefusal);
  });

  it('keeps the not-signed-in message unchanged', () => {
    // risk: sign-in (signed-out state must still prompt sign-in, not a connection error)
    const { mapper } = mapperWithSink();

    expect(mapper.map(new Error('Not signed in to Sulla Cloud'))).toEqual({
      ok: false, code: 'not_signed_in', error: 'Sign in to Sulla Cloud to see your devices.',
    });
  });

  it('passes a domain refusal through with its own code and message', () => {
    // risk: data accuracy (the removal guard message the panel shows must stay exact)
    const { mapper } = mapperWithSink();
    const refusal = new DevicesPanelError('this_device', 'This computer can\'t be removed from here. Sign out instead.');

    expect(mapper.map(refusal)).toEqual({ ok: false, code: 'this_device', error: 'This computer can\'t be removed from here. Sign out instead.' });
  });

  it('does not call an unrecognised failure a connection problem', () => {
    // risk: data accuracy (an unknown Cloud error must not be blamed on the user's connection)
    const { mapper } = mapperWithSink();

    expect(mapper.map(new Error('something unexpected')).code).toBe('cloud_error');
  });
});
