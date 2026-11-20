// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { ModelCompatibilityService, ProviderClientStatus } from '../../../languagemodels/ModelCompatibilityService';

describe('Cloud metadata versus installed CLI compatibility', () => {
  it('allows a sufficiently new client without changing the exact model', async() => {
    // risk: exact execution identity
    const service = new ModelCompatibilityService(async() => ({ required: true, installed: true, version: 'codex-cli 1.3.0' }));
    await expect(service.assertClient('codex', { id: 'official-model', minimumClientVersion: '1.2.3' })).resolves.toBeUndefined();
  });
  it('rejects old and unknown clients rather than selecting another model', async() => {
    // risk: unsupported transport / silent downgrade
    const service = new ModelCompatibilityService(async() => ({ required: true, installed: true, version: 'codex-cli 1.2.2' }));
    await expect(service.assertClient('codex', { id: 'official-model', minimumClientVersion: '1.2.3' })).rejects.toThrow('requires client 1.2.3');
    const unknown = new ModelCompatibilityService(async() => ({ required: true, installed: true }));
    await expect(unknown.assertClient('codex', { id: 'official-model', minimumClientVersion: '1.2.3' })).rejects.toThrow('Cannot verify');
  });
  it('keeps API identity separate from CLI version gates', async() => {
    // risk: cross-transport entitlement inference
    const service = new ModelCompatibilityService(async() => ({ required: false, installed: true }));
    await expect(service.assertClient('openai', { id: 'api-model', minimumClientVersion: '1.2.3' })).resolves.toBeUndefined();
  });
  it('uses the explicitly selected or actual image CLI version rather than VM-helper version', async() => {
    // risk: worker transport compatibility
    const selected = new ProviderClientStatus(async() => ({ codex: '1.2.3' }), async() => '1.0.0', async() => ({ required: true, installed: true, version: '9.9.9' }));
    expect((await selected.get('codex')).version).toBe('1.2.3');
    const image = new ProviderClientStatus(async() => ({}), async() => '1.0.0', async() => ({ required: true, installed: true, version: '9.9.9' }));
    await expect(new ModelCompatibilityService(provider => image.get(provider)).assertClient('codex', { id: 'official-model', minimumClientVersion: '1.2.3' })).rejects.toThrow('requires client');
    const invalid = new ProviderClientStatus(async() => ({ codex: 'latest' }), async() => '9.9.9', async() => ({ required: false, installed: true }));
    await expect(invalid.get('codex')).rejects.toThrow('selection is invalid');
  });

});
