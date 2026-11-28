// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ default: { app: { getPath: () => '/ud', getVersion: () => '0.0.0' } }, app: { getPath: () => '/ud', getVersion: () => '0.0.0' } }));
vi.mock('@pkg/main/supportState', () => ({ SupportStateStore: class {} }));
vi.mock('@pkg/main/support/supportCloud', () => ({ supportCloudRequest: vi.fn() }));

import { SupportTimelineRecorder, type SupportTimelineDeps } from './supportTimeline';

function deps(overrides: Partial<SupportTimelineDeps> = {}): SupportTimelineDeps {
  return { metricsConsent: () => true, appVersion: () => '1.2.3', request: vi.fn(async () => undefined), ...overrides };
}

describe('SupportTimelineRecorder', () => {
  it('posts the event with the app version when metrics consent is on', async () => {
    const d = deps();

    await new SupportTimelineRecorder(d).record('installed', { platform: 'darwin' });
    expect(d.request).toHaveBeenCalledWith('POST', '/support/timeline', {
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify({ eventType: 'installed', appVersion: '1.2.3', data: { platform: 'darwin' } }),
    });
  });

  // risk: consent — nothing leaves the machine without metrics consent
  it('sends nothing without metrics consent', async () => {
    const d = deps({ metricsConsent: () => false });

    await new SupportTimelineRecorder(d).record('error');
    expect(d.request).not.toHaveBeenCalled();
  });

  it('never throws when the consent read or the request fails', async () => {
    await expect(new SupportTimelineRecorder(deps({ metricsConsent: () => { throw new Error('x') } })).record('error')).resolves.toBeUndefined();
    await expect(new SupportTimelineRecorder(deps({ request: async () => { throw new Error('net') } })).record('error')).resolves.toBeUndefined();
  });
});
