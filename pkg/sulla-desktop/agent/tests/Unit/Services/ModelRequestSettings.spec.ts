// SPDX-License-Identifier: GPL-2.0-or-later
// Preferences → AI models → Request settings must reach the model services.
// Before this fix nothing read remoteRetryCount / remoteTimeoutSeconds, so the
// two inputs saved values that never changed a request.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleService } from '../../../languagemodels/OpenAICompatibleService';
import { ModelRequestSettings, RETRY_COUNT_KEY, TIMEOUT_SECONDS_KEY } from '../../../languagemodels/ModelRequestSettings';
import { providerFetch } from '../../../languagemodels/providerBroker';

// Replace process/transport boundaries, not the logic under test.
vi.mock('@pkg/main/cloud/byoUsageSync', () => ({ ByoUsageSync: class {} }));
vi.mock('../../../services/IntegrationService', () => ({ getIntegrationService: vi.fn() }));
vi.mock('@pkg/main/firstRun/firstRunTrace', () => ({ firstRunTrace: vi.fn() }));
vi.mock('../../../languagemodels/providerBroker', () => ({ providerFetch: vi.fn() }));

class FixtureService extends OpenAICompatibleService {
  constructor() { super({ id: 'grok', model: 'fixture', baseUrl: 'https://example.invalid', apiKey: 'synthetic' }); }
  request() { return this.sendRawRequest([{ role: 'user', content: 'fixture' }], {}); }
}

/** In-memory stand-in for the Sulla settings table. */
function settings(values: Record<string, unknown>) {
  return { get: async(key: string, fallback: unknown = null) => (key in values ? values[key] : fallback) };
}

afterEach(() => vi.restoreAllMocks());

describe('ModelRequestSettings', () => {
  // risk: core business rule — the owner's saved retry count must decide how many times a failing provider is hit.
  it('a saved retry count of 0 makes a failing provider get exactly one request', async() => {
    const service = new FixtureService();
    vi.mocked(providerFetch).mockReset().mockImplementation(async() => new Response('busy', { status: 503 }));

    await new ModelRequestSettings(settings({ [RETRY_COUNT_KEY]: 0 })).applyTo(service);

    await expect(service.request()).rejects.toThrow(/503/);
    expect(vi.mocked(providerFetch)).toHaveBeenCalledTimes(1);
  });

  // risk: core business rule — the saved timeout must bound each request.
  it('a saved timeout becomes the request deadline', async() => {
    const service = new FixtureService();
    const spy = vi.spyOn(service as any, 'combinedSignal');
    vi.mocked(providerFetch).mockReset().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] })));

    await new ModelRequestSettings(settings({ [TIMEOUT_SECONDS_KEY]: '45' })).applyTo(service);
    await service.request();

    expect(spy.mock.calls[0][1]).toBe(45_000);
  });

  // risk: regression — untouched installs must keep each provider's own defaults.
  it('changes nothing until the owner saves a value', async() => {
    const service = { setRetryCount: vi.fn(), setDefaultTimeoutSeconds: vi.fn() };

    expect(await new ModelRequestSettings(settings({})).applyTo(service)).toEqual({ retries: undefined, timeoutSeconds: undefined });
    expect(service.setRetryCount).not.toHaveBeenCalled();
    expect(service.setDefaultTimeoutSeconds).not.toHaveBeenCalled();
  });

  // risk: data accuracy — a corrupt or out-of-range stored value must not reach a provider.
  it('ignores out-of-range and non-numeric values', async() => {
    const service = { setRetryCount: vi.fn(), setDefaultTimeoutSeconds: vi.fn() };

    await new ModelRequestSettings(settings({ [RETRY_COUNT_KEY]: 11, [TIMEOUT_SECONDS_KEY]: 'soon' })).applyTo(service);
    await new ModelRequestSettings(settings({ [RETRY_COUNT_KEY]: -1, [TIMEOUT_SECONDS_KEY]: 4 })).applyTo(service);

    expect(service.setRetryCount).not.toHaveBeenCalled();
    expect(service.setDefaultTimeoutSeconds).not.toHaveBeenCalled();
  });

  // risk: core business rule — CLI agents (Claude Code, Codex) have no HTTP retry knobs and must not break.
  it('leaves services without the setters alone', async() => {
    await expect(new ModelRequestSettings(settings({ [RETRY_COUNT_KEY]: 2, [TIMEOUT_SECONDS_KEY]: 30 })).applyTo({})).resolves.toEqual({ retries: 2, timeoutSeconds: 30 });
  });
});
