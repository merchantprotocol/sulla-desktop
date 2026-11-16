// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// E9 app.ts: the VaultApplication composition root itself (not only the deprecated createApp
// alias) builds the legacy route table, keeps the enrollment path literals the bundled-image
// parity check reads, and answers like the legacy app.

import { describe, expect, it } from 'vitest';

import { VaultApplication } from '../../../../../../services/sulla-vault/src/app';
import { createApp as createLegacyApp } from '../../Support/E9Legacy/app.legacy';
import { AuthorityDouble, DatabaseDouble, VaultAppConfigFactory, VaultAppProbe, VaultRouteTable } from '../../Support/Vault/E9VaultAppHarness';

describe('E9 VaultApplication', () => {
  const config = new VaultAppConfigFactory();

  it('builds the same route table as the legacy createApp', () => { // risk: auth/origin middleware reordered behind handlers
    const table = new VaultRouteTable();
    const legacy = table.describe(createLegacyApp(new DatabaseDouble().db, config.create(), { localAuthority: new AuthorityDouble().authority }));
    const current = table.describe(new VaultApplication(new DatabaseDouble().db, config.create(), { localAuthority: new AuthorityDouble().authority }).build());
    expect(current).toEqual(legacy);
  });

  it('serves the enrollment routes from its declared paths', () => { // risk: bundled image missing Desktop enrollment routes
    expect(VaultApplication.enrollmentPaths).toEqual({
      wrap: '/v1/broker/sulla-cloud/enrollment-wrap',
      adopt: '/v1/broker/sulla-cloud/enrollment-adopt',
      commit: '/v1/broker/sulla-cloud/enrollment-commit',
    });
  });

  it('refuses an enrollment commit from a non-approval caller exactly like the legacy app', async() => { // risk: enrollment commit without approval identity
    const probe = new VaultAppProbe();
    const request = { method: 'POST', path: '/v1/broker/sulla-cloud/enrollment-commit', headers: { 'x-sulla-service-id': 'sulla-tools', authorization: 'Bearer x' }, body: { requestId: 'r' } };
    const run = async(build: (authority: AuthorityDouble) => Parameters<VaultAppProbe['send']>[0]) => {
      const authority = new AuthorityDouble().on('requireApprovalIdentity', () => { throw Object.assign(new Error('nope'), { code: '23505' }) });
      const outcome = await probe.send(build(authority), request);
      return { outcome, calls: authority.calls };
    };
    const legacy = await run(authority => createLegacyApp(new DatabaseDouble().db, config.create(), { localAuthority: authority.authority }));
    const current = await run(authority => new VaultApplication(new DatabaseDouble().db, config.create(), { localAuthority: authority.authority }).build());
    expect(legacy.outcome.status).toBe(409);
    expect(current).toEqual(legacy);
    expect(current.calls.map(call => call.method)).toEqual(['requireApprovalIdentity']);
  });
});
