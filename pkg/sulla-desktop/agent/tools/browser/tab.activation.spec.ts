// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
const registry = vi.hoisted(() => ({ open: vi.fn(), requestActivation: vi.fn(), bridge: vi.fn(() => null) }));
vi.mock('@pkg/main/browserTabs/TabRegistry', () => ({ tabRegistry: registry }));
import { BrowserTabWorker } from './tab';
class TestBrowserTabWorker extends BrowserTabWorker {
  run(input: unknown) { return this._validatedCall(input); }
}
describe('browser tool activation intent', () => {
  it.each([false, undefined, 'true'])('does not navigate the human for active=%s', async(active) => {
    // risk: background agent work disrupts the human route
    registry.requestActivation.mockClear();
    await new TestBrowserTabWorker().run({ assetId: 'background', url: 'https://example.com', active });
    expect(registry.requestActivation).not.toHaveBeenCalled();
  });
  it('passes explicit activation and controller-bound ownership after opening', async() => {
    // risk: explicit visible QA request silently remains hidden
    registry.requestActivation.mockClear();
    const worker = new TestBrowserTabWorker();
    const owner = { kind: 'graph' as const, sessionId: 'qa' };
    worker.setTabOwner(owner);
    await worker.run({ assetId: 'qa', url: 'https://example.com', active: true });
    expect(registry.open).toHaveBeenLastCalledWith(expect.objectContaining({ assetId: 'qa', owner }));
    expect(registry.requestActivation).toHaveBeenCalledWith('qa', owner);
  });
});
