import { describe, expect, it } from 'vitest';
import { ProviderBridgeActivity } from '../../../../vault-broker/ProviderBridgeActivity';

describe('ProviderBridgeActivity', () => {
  it('keeps a Codex run alive through long upstream generation', () => {
    // risk: recovery — a healthy 200s provider response must not be classified as a dead CLI.
    const activity = new ProviderBridgeActivity();
    activity.mark('pod-a', 200_000);

    expect(activity.isActiveSince('pod-a', 20_000)).toBe(true);
  });

  it('does not report activity for a true 181s stall', () => {
    // risk: recovery — dead provider streams must still time out.
    const activity = new ProviderBridgeActivity();

    expect(activity.isActiveSince('pod-a', 181_000)).toBe(false);
  });

  it('does not let another container keep this run alive', () => {
    // risk: isolation — unrelated agent work must not mask this run's stall.
    const activity = new ProviderBridgeActivity();
    activity.mark('pod-b', 200_000);

    expect(activity.isActiveSince('pod-a', 20_000)).toBe(false);
  });
});
