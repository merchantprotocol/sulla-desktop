// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { FilesSafeDiagnosticError } from '../src/startupDiagnostics.js';
import { VaultFilesKeyBundleAuthority } from '../src/vaultKeyBundleAuthority.js';
import { VaultStartupRetryPolicy } from '../src/VaultStartupRetryPolicy.js';

const httpError = (httpStatus:number) => new FilesSafeDiagnosticError({ code: 'FILES_VAULT_AUTHORITY_HTTP_FAILED', class: 'vault-authority', operation: 'principal-read', httpStatus });
const token = 'x'.repeat(32);

describe('Vault startup retry policy', () => {
  const servers:http.Server[] = [];
  afterEach(async() => { await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve)))) });

  /** Loopback Vault that answers 423 (locked) `lockedFor` times, then 200 with a principal. */
  async function vault(lockedFor:number):Promise<{ url:string; calls:() => number }> {
    let calls = 0;
    const server = http.createServer((_request, response) => {
      calls++;
      if (calls <= lockedFor) { response.writeHead(423).end(); return }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ principalId: 'p1', generation: 3 }));
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${ (server.address() as AddressInfo).port }`, calls: () => calls };
  }

  it('retries a locked Vault (423) and transport errors but never auth failures', () => {
    // risk: sign-in — a revoked service identity (401/403) must fail fast, not spin for two minutes.
    const policy = new VaultStartupRetryPolicy();
    expect(policy.isRetryable(httpError(423))).toBe(true);
    expect(policy.isRetryable(httpError(401))).toBe(false);
    expect(policy.isRetryable(httpError(403))).toBe(false);
    expect(policy.isRetryable(httpError(500))).toBe(false);
    expect(policy.isRetryable(new FilesSafeDiagnosticError({ code: 'FILES_VAULT_AUTHORITY_REQUEST_FAILED', class: 'vault-authority', operation: 'principal-read' }, Object.assign(new Error('x'), { code: 'ECONNREFUSED' })))).toBe(true);
    expect(policy.isRetryable(Object.assign(new Error('x'), { code: 'EACCES' }))).toBe(false);
  });

  it('backs off exponentially up to the cap and gives up after the window', async() => {
    // risk: startup availability — the retry budget and backoff must be exactly as configured.
    let now = 0; const waits:number[] = [];
    const policy = new VaultStartupRetryPolicy({ windowMs: 1_000, initialDelayMs: 100, maxDelayMs: 300, now: () => now, sleep: async ms => { waits.push(ms); now += ms } });
    let attempts = 0;
    const locked = httpError(423);
    await expect(policy.run('principal-read', async() => { attempts++; throw locked })).rejects.toBe(locked);
    expect(waits).toEqual([100, 200, 300, 300, 300]);
    expect(attempts).toBe(6);
  });

  it('keeps retry configuration per instance: two policies never share state', () => {
    // risk: hidden module state — one authority's retry settings must not leak into another's.
    const narrow = new VaultStartupRetryPolicy({ retryableCodes: ['ECONNRESET'] });
    const standard = new VaultStartupRetryPolicy();
    const notFound = Object.assign(new Error('x'), { code: 'ENOTFOUND' });
    expect(narrow.isRetryable(notFound)).toBe(false);
    expect(standard.isRetryable(notFound)).toBe(true);
    expect(new VaultStartupRetryPolicy().isRetryable(notFound)).toBe(true);
  });

  it('each authority instance uses its own policy against a Vault that is still locked', async() => {
    // risk: startup — a patient authority must wait out the lock while an impatient one fails, independently.
    const patientVault = await vault(2);
    const impatientVault = await vault(2);
    const patient = new VaultFilesKeyBundleAuthority({ baseUrl: patientVault.url, serviceId: 'files', serviceToken: token },
      new VaultStartupRetryPolicy({ sleep: async() => undefined }));
    const impatient = new VaultFilesKeyBundleAuthority({ baseUrl: impatientVault.url, serviceId: 'files', serviceToken: token },
      new VaultStartupRetryPolicy({ windowMs: 0, sleep: async() => undefined }));
    await expect(patient.unlockedPrincipal()).resolves.toEqual({ principalId: 'p1', generation: 3 });
    expect(patientVault.calls()).toBe(3);
    await expect(impatient.unlockedPrincipal()).rejects.toBeInstanceOf(FilesSafeDiagnosticError);
    expect(impatientVault.calls()).toBe(1);
  });
});
