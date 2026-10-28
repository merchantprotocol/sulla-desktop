// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { Ed25519SignatureVerifier, firstPartyPackage, integrationGrantMatches, integrationPackageHash, IntegrationPackageLoader } from '../packageLoader';

import type { Integration } from '../types';

const integration = { id: 'acme', name: 'Acme', description: 'Acme API', category: 'Developer Tools' } as Integration;

function thirdParty() {
  const pkg = firstPartyPackage(integration);
  pkg.firstParty = false;
  pkg.manifest.permissions = ['network:api.acme.test'];
  pkg.manifest.baseUrls = ['https://api.acme.test'];
  pkg.manifest.proxyPaths = [{ method: 'GET', path: '/v1/items' }];
  pkg.manifest.integrity = integrationPackageHash(pkg);
  return pkg;
}

describe('IntegrationPackageLoader security boundary', () => {
  it('refuses a hash mismatch', async() => {
    const pkg = thirdParty();
    pkg.files['builtin.entry'] = 'tampered';
    const loader = new IntegrationPackageLoader({ isGranted: () => true }, { request: async() => null }, { verify: () => true });
    await expect(loader.load(pkg)).rejects.toThrow('integrity mismatch');
  });

  it('refuses an ungranted integration', async() => {
    const loader = new IntegrationPackageLoader({ isGranted: () => false }, { request: async() => null }, { verify: () => true });
    await expect(loader.load(thirdParty())).rejects.toThrow('has not been granted');
  });

  it('refuses an unsigned third-party package', async() => {
    const loader = new IntegrationPackageLoader({ isGranted: () => true }, { request: async() => null }, new Ed25519SignatureVerifier({ keys: [] }));
    await expect(loader.load(thirdParty())).rejects.toThrow('signature verification failed');
  });

  it('requires a new grant when permissions change', () => {
    const grant = { granted: true, permissions: ['network:api.acme.test'] };
    expect(integrationGrantMatches(grant, ['network:api.acme.test'])).toBe(true);
    expect(integrationGrantMatches(grant, ['network:api.acme.test', 'account:write'])).toBe(false);
  });

  it('never exposes vault credentials to package code', async() => {
    const proxy = { request: jest.fn(async() => ({ ok: true })) };
    const loader = new IntegrationPackageLoader({ isGranted: () => true }, proxy, { verify: () => true });
    const { api } = await loader.load(thirdParty());
    expect('vault' in api).toBe(false);
    expect('credentials' in api).toBe(false);
    await api.proxy({ method: 'GET', path: '/v1/items' });
    expect(proxy.request).toHaveBeenCalledWith({ integrationId: 'acme', method: 'GET', path: '/v1/items' });
    await expect(api.proxy({ method: 'POST', path: '/v1/items' })).rejects.toThrow('not declared');
    expect(proxy.request).toHaveBeenCalledTimes(1);
  });
});
