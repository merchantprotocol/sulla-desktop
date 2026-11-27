// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
//
// The Clerk settings save runs end to end: Desktop ClerkSettingsService, the real approval and broker
// clients, the real vault HTTP app and LocalVaultAuthority on a migrated database. Only Clerk's API
// (fake upstream) and, in one case, the vault's write reply are replaced. "Saved" must mean the
// account is stored and readable through the broker, never just that the write call answered 2xx.

import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fetch as undiciFetch } from 'undici';
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:crypto', async importOriginal => (await import('../../Support/E9Legacy/E9TestDoubles')).E9NodeDeterminism.cryptoModule(await importOriginal<Record<string, unknown>>()));
vi.mock('node:dns', async importOriginal => (await import('../../Support/E9Legacy/E9TestDoubles')).E9FakeUpstream.dnsModule(await importOriginal<Record<string, unknown>>()));
vi.mock('node:https', async importOriginal => (await import('../../Support/E9Legacy/E9TestDoubles')).E9FakeUpstream.httpsModule(await importOriginal<Record<string, unknown>>()));

import { createApp } from '../../../../../../services/sulla-vault/src/app';
import { LocalVaultAuthority } from '../../../../../../services/sulla-vault/src/localAuthority';
import { ClerkSettingsService, type ClerkSettingsResult } from '../../../../main/ClerkSettingsService';
import { LocalVaultBrokerClient } from '../../../../vault-broker';
import { LocalVaultApprovalClient } from '../../../../vault-broker/LocalVaultApprovalClient';
import { E9_TOKENS, E9ScenarioRunner, type E9Context } from '../../Support/E9Legacy/E9LocalAuthorityEquivalence';

const PUBLISHABLE = `pk_test_${ Buffer.from('clerk.example.invalid$').toString('base64') }`;
const SECRET = 'sk_test_FIXTUREONLY';
const ROTATED = 'sk_test_FIXTUREROTATED';

type Transport = (input: string, init?: RequestInit) => Promise<Response>;
/** Replaces the vault's reply to one save's write call; `forward` sends it to the real vault. */
type WriteReply = (forward: Transport, input: string, init?: RequestInit) => Promise<Response>;
interface SaveStep { secret?: string; input?: unknown; disconnect?: boolean; writeReply?: WriteReply; revisionBefore?: number }
interface Outcome { saves: ClerkSettingsResult[]; loaded: ClerkSettingsResult; rows: number; secrets: string[]; logs: string[] }

/** A write reply that looks like a stored, connected staging section but stores nothing. */
const droppedWrite: WriteReply = async() => new Response(JSON.stringify({
  integrationId: 'clerk', activeAccountId: 'default', accounts: [{
    accountId: 'default', label: 'Clerk', connected: true, credentialRequired: true, active: true, revision: 99,
    properties: { connection_status: 'connected', staging_publishable_key: PUBLISHABLE, staging_instance_id: 'ins_fixture' },
  }],
}), { status: 200, headers: { 'content-type': 'application/json' } });

/** Runs saves in order through the real stack, then reads the stored state back. */
async function saveThroughVault(steps: SaveStep[], options: { int8AsText?: boolean } = {}): Promise<Outcome> {
  let outcome: Outcome | undefined;
  await new E9ScenarioRunner().run(LocalVaultAuthority, [
    { name: 'unlock', run: c => c.bootstrap.unlock(c.authority, Buffer.alloc(32, 0x11), 'n'.repeat(43)) },
    { name: 'save', run: async(c: E9Context) => {
      const ok = (body: unknown) => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      c.upstream.reply('GET api.clerk.com/v1/instance', ok({ id: 'ins_fixture', environment_type: 'development' }));
      c.upstream.reply('GET api.clerk.com/v1/domains', ok({ data: [{ frontend_api_url: 'https://clerk.example.invalid' }] }));
      const spool = mkdtempSync(join(tmpdir(), 'clerk-settings-'));
      const app = createApp(c.database.db as never, {
        mode: 'desktop', port: 0, databaseUrl: 'postgresql://synthetic/unused', extensionOrigins: [], auditSpoolDir: spool,
        bootstrapServiceId: 'bootstrap', bootstrapServiceToken: E9_TOKENS.bootstrap,
        controlServiceId: 'control', controlServiceToken: E9_TOKENS.control,
        approvalServiceId: 'approval', approvalServiceToken: E9_TOKENS.approval,
        brokerServiceId: 'broker', brokerServiceToken: E9_TOKENS.broker,
        filesServiceId: 'files', filesServiceToken: E9_TOKENS.files,
      } as never, { localAuthority: c.authority });
      const server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) });
      try {
        const origin = `http://127.0.0.1:${ (server.address() as AddressInfo).port }`;
        const forward: Transport = (input, init) => undiciFetch(input.replace('https://127.0.0.1', origin), init as never) as unknown as Promise<Response>;
        // Production pg returns the bigint items.revision as a decimal string; the embedded test database does not.
        const brokerTransport: Transport = async(input, init) => {
          const response = await forward(input, init);
          if (!options.int8AsText || !input.includes('/metadata')) return response;
          const body = await response.json() as { accounts?: Array<{ revision: unknown }> };
          for (const account of body.accounts ?? []) account.revision = String(account.revision);
          return new Response(JSON.stringify(body), { status: response.status, headers: { 'content-type': 'application/json' } });
        };
        let writeReply: WriteReply | undefined;
        const logs: string[] = [];
        const ownerTransport: Transport = (input, init) => writeReply && input.endsWith('/desktop-account') ? writeReply(forward, input, init) : forward(input, init);
        const service = new ClerkSettingsService(
          () => new LocalVaultApprovalClient('https://127.0.0.1', { serviceId: 'approval', serviceToken: E9_TOKENS.approval }, ownerTransport),
          () => new LocalVaultBrokerClient('https://127.0.0.1', { serviceId: 'broker', serviceToken: E9_TOKENS.broker }, brokerTransport),
          line => logs.push(line),
        );
        const saves: ClerkSettingsResult[] = [];
        for (const step of steps) {
          writeReply = step.writeReply;
          if (step.revisionBefore) await c.database.db.query("UPDATE items SET revision=$1 WHERE integration_ref='clerk/default'", [step.revisionBefore]);
          saves.push(await service.save(step.input ?? { staging_publishable_key: PUBLISHABLE, staging_secret_key: step.secret }, step.disconnect));
        }
        const loaded = await service.load();
        const rows = (await c.database.db.query("SELECT 1 FROM items WHERE integration_ref='clerk/default' AND deleted_at IS NULL")).rows.length;
        // The fixture secrets Clerk's fake API was called with during verification.
        const secrets = c.upstream.requests.map(request => Object.values((request as { headers?: Record<string, string> }).headers ?? {}).join(' '));
        outcome = { saves, loaded, rows, secrets, logs };
      } finally {
        server.close();
        rmSync(spool, { recursive: true, force: true });
      }
    } },
  ]);
  if (!outcome) throw new Error('scenario did not run');
  return outcome;
}

describe('Clerk settings save is confirmed by a read of the stored account', () => {
  it('reports saved only when the account is stored and the broker reads the section as connected', async() => {
    const { saves: [saved], loaded, rows } = await saveThroughVault([{ secret: SECRET }]);
    expect(rows).toBe(1);
    expect(saved.success).toBe(true);
    expect(saved.settings?.staging).toMatchObject({ connected: true, instanceId: 'ins_fixture', publishableKey: PUBLISHABLE });
    expect(loaded.success && loaded.settings.staging.connected).toBe(true);
  }, 180_000);

  it('does not report saved when the write call answers like a stored account but nothing was stored', async() => {
    const { saves: [saved], loaded, rows } = await saveThroughVault([{ secret: SECRET, writeReply: droppedWrite }]);
    expect(rows).toBe(0);
    expect(saved.success).toBe(false);
    expect(saved.settings?.staging.connected).toBe(false);
    expect(loaded.success && loaded.settings.staging.connected).toBe(false);
  }, 180_000);

  it('reports a secret rotation as saved only when the rotated pair was stored', async() => {
    const stored = await saveThroughVault([{ secret: SECRET }, { secret: ROTATED }]);
    expect(stored.saves.map(save => save.success)).toEqual([true, true]);
    expect(stored.secrets.some(header => header.includes(ROTATED))).toBe(true);

    const dropped = await saveThroughVault([{ secret: SECRET }, { secret: ROTATED, writeReply: droppedWrite }]);
    expect(dropped.saves.map(save => save.success)).toEqual([true, false]);
    // The old pair is still the stored one: the dropped rotation never reached Clerk verification either.
    expect(dropped.loaded.success && dropped.loaded.settings.staging.connected).toBe(true);
    expect(dropped.secrets.some(header => header.includes(ROTATED))).toBe(false);
  }, 180_000);
  it('confirms a committed save when the vault sends revisions as decimal text across a digit boundary', async() => {
    const { saves } = await saveThroughVault([{ secret: SECRET }, { secret: ROTATED, revisionBefore: 9 }], { int8AsText: true });
    expect(saves.map(save => save.success)).toEqual([true, true]);
  }, 180_000);
  it.each([
    ['staging', 'production'],
    ['production', 'staging'],
  ] as const)('A3: saves a valid %s pair even when the %s pair in the same save is invalid, and reports each section', async(good, bad) => {
    const input = {
      [`${ good }_publishable_key`]: PUBLISHABLE, [`${ good }_secret_key`]: SECRET,
      [`${ bad }_publishable_key`]:  PUBLISHABLE, [`${ bad }_secret_key`]:  '',
    };
    const { saves: [saved], loaded, logs } = await saveThroughVault([{ input }]);
    const badLabel = bad === 'staging' ? 'Staging' : 'Production';
    expect(saved.success).toBe(false);
    expect(saved.sections).toEqual({ [good]: { saved: true }, [bad]: { saved: false, error: `${ badLabel }: the secret key is empty. Enter both keys for this section, or clear both to leave it unset.` } });
    expect(saved.success === false && saved.error).toBe(`${ badLabel }: the secret key is empty. Enter both keys for this section, or clear both to leave it unset.`);
    expect(saved.settings?.[good].connected).toBe(true);
    expect(saved.settings?.[bad].connected).toBe(false);
    expect(loaded.success && loaded.settings[good].connected).toBe(true);
    // One outcome line per section, always in staging-then-production order.
    expect(logs).toHaveLength(2);
    expect(logs.find(line => line.includes(`save sections=${ good } `))).toContain('confirmed');
    expect(logs.find(line => line.includes(`save sections=${ bad } `))).toContain(`failed: invalid_operation 400 -> ${ badLabel }: the secret key is empty.`);
  }, 180_000);

  it('A3: reports both sections saved when both pairs are valid', async() => {
    const input = {
      staging_publishable_key: PUBLISHABLE, staging_secret_key: SECRET,
      production_publishable_key: PUBLISHABLE, production_secret_key: ROTATED,
    };
    const { saves: [saved], loaded } = await saveThroughVault([{ input }]);
    expect(saved).toMatchObject({ success: true, sections: { staging: { saved: true }, production: { saved: true } } });
    expect(loaded.success && loaded.settings.staging.connected && loaded.settings.production.connected).toBe(true);
  }, 180_000);

  it('logs every outcome without any submitted value or echoed response text', async() => {
    const pasted = 'my-pasted-password-' + 'x'.repeat(1100);
    const echoed = 'sk_test_ECHOEDFIXTURE';
    const malformed = { staging_publishable_key: 'pk_test_NOTAREALKEY', staging_secret_key: 'sk_test_MALFORMEDFIXTURE' };
    const wordsOnly = 'correct horse battery staple';
    const echoWords: WriteReply = async() => new Response(JSON.stringify({ error: 'invalid_operation', message: `Staging: ${ wordsOnly }.` }), { status: 400, headers: { 'content-type': 'application/json' } });
    const echoReply: WriteReply = async() => new Response(JSON.stringify({ error: echoed, message: `bad ${ echoed }` }), { status: 400, headers: { 'content-type': 'application/json' } });
    const { saves, logs } = await saveThroughVault([
      { secret: SECRET },
      { input: { staging_publishable_key: pasted } },
      { input: malformed },
      { secret: ROTATED, writeReply: echoReply },
      { secret: ROTATED, writeReply: echoWords },
      { input: {}, disconnect: true },
    ]);
    expect(saves.map(save => save.success)).toEqual([true, false, false, false, false, true]);
    expect(logs).toHaveLength(6);
    expect(logs[1]).toContain('rejected before the vault');
    expect(logs[2]).toContain('invalid_operation 400');
    expect(logs[3]).toContain('other code 400');
    expect(logs[2]).toContain('Staging: the publishable key is malformed (it does not decode to a Clerk frontend address).');
    expect(logs[4]).toContain('invalid_operation 400 -> unlisted message');
    expect(logs[5]).toContain('disconnect sections=staging,production confirmed');
    for (const value of [SECRET, ROTATED, PUBLISHABLE, pasted, echoed, wordsOnly, ...Object.values(malformed)]) {
      expect(logs.some(line => line.includes(value))).toBe(false);
    }
  }, 180_000);
});
