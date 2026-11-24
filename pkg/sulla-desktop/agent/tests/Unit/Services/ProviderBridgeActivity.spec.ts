import { describe, expect, it } from 'vitest';
import { ProviderBridgeActivity } from '../../../../vault-broker/ProviderBridgeActivity';

describe('ProviderBridgeActivity', () => {
  it('records activity for the matching provider pod', () => {
    // risk: bridge liveness must stay isolated to the container that owns the stream.
    const activity = new ProviderBridgeActivity();
    activity.mark('pod-a', 200_000);

    expect(activity.isActiveSince('pod-a', 20_000)).toBe(true);
  });

  it('reports an old stream timestamp as inactive', () => {
    // risk: recovery — dead provider streams must still time out.
    const activity = new ProviderBridgeActivity();

    expect(activity.isActiveSince('pod-a', 181_000)).toBe(false);
  });

  it('does not report activity across provider pod IDs', () => {
    // risk: isolation — unrelated agent work must not mask this run's stall.
    const activity = new ProviderBridgeActivity();
    activity.mark('pod-b', 200_000);

    expect(activity.isActiveSince('pod-a', 20_000)).toBe(false);
  });

  it('publishes retry status only to the matching pod without advancing stream activity', () => {
    // risk: a rate-limited provider could either reset Codex's silence clock or leak one job's status to another.
    const activity = new ProviderBridgeActivity();
    activity.mark('pod-a', 100);
    const podA: unknown[] = [];
    const podB: unknown[] = [];
    const unsubscribe = activity.subscribeRetryStatus('pod-a', status => podA.push(status));
    activity.subscribeRetryStatus('pod-b', status => podB.push(status));

    activity.publishRetryStatus('pod-a', { status: 429, reason: 'request rate limit exceeded', retryAfterSeconds: 9 });

    expect(podA).toEqual([{ status: 429, reason: 'request rate limit exceeded', retryAfterSeconds: 9 }]);
    expect(podB).toEqual([]);
    expect(activity.lastActivityAt('pod-a')).toBe(100);
    unsubscribe();
    activity.publishRetryStatus('pod-a', { status: 503 });
    expect(podA).toHaveLength(1);
  });
});
