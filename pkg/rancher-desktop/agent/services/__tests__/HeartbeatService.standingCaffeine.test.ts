/**
 * Standing sleep-prevention regression tests.
 *
 * The bug: caffeinate was only held DURING a heartbeat execution, so the Mac
 * could idle-sleep in the inter-cycle gap, freezing the scheduler timer —
 * and scheduleWake() is a root-gated no-op, so nothing woke it. These tests
 * pin the fix: while heartbeatEnabled is true the standing hold is acquired
 * exactly once (not every minute), released when disabled, and released on
 * destroy so the caffeinate process can't leak across a teardown.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const startCaffeinateMock: any = jest.fn();
const stopCaffeinateMock: any = jest.fn();
const getSettingMock: any = jest.fn();

// ESM: jest.unstable_mockModule + dynamic import (see SubconsciousMiddleware.test.ts).
jest.unstable_mockModule('../../../main/SleepPreventionService', () => ({
  startCaffeinate: startCaffeinateMock,
  stopCaffeinate:  stopCaffeinateMock,
  scheduleWake:    jest.fn(),
}));
jest.unstable_mockModule('../../database/models/SullaSettingsModel', () => ({
  SullaSettingsModel: {
    get: getSettingMock,
    set: jest.fn(),
  },
}));

const STANDING = 'heartbeat-standing';

/** Make SullaSettingsModel.get return `enabled` for heartbeatEnabled, defaults otherwise. */
function useSettings(enabled: boolean) {
  getSettingMock.mockImplementation((key: string, dflt: unknown) => {
    if (key === 'heartbeatEnabled') return Promise.resolve(enabled);
    if (key === 'heartbeatWindow') return Promise.resolve(null);
    return Promise.resolve(dflt);
  });
}

/** A service parked so checkAndMaybeTrigger exercises only the caffeine path (never dispatches a cycle). */
async function makeParkedService(): Promise<any> {
  const { HeartbeatService } = await import('../HeartbeatService');
  const svc: any = new HeartbeatService();
  svc.initialized = true;
  // Recent last-trigger → the delay gate short-circuits before triggerHeartbeat.
  svc.lastTriggerMs = Date.now();
  return svc;
}

const standingStarts = () => startCaffeinateMock.mock.calls.filter((c: unknown[]) => c[0] === STANDING);

describe('HeartbeatService standing sleep-prevention', () => {
  beforeEach(() => {
    startCaffeinateMock.mockReset();
    stopCaffeinateMock.mockReset();
    getSettingMock.mockReset();
  });

  it('acquires the standing hold once while enabled, even across many minute-checks', async() => {
    useSettings(true);
    const svc = await makeParkedService();

    await svc.checkAndMaybeTrigger();
    await svc.checkAndMaybeTrigger();
    await svc.checkAndMaybeTrigger();

    expect(standingStarts()).toHaveLength(1); // transition-guarded, not per-minute
    expect(stopCaffeinateMock).not.toHaveBeenCalledWith(STANDING);
  });

  it('releases the standing hold when the heartbeat is disabled', async() => {
    const svc = await makeParkedService();

    useSettings(true);
    await svc.checkAndMaybeTrigger();
    expect(startCaffeinateMock).toHaveBeenCalledWith(STANDING);

    useSettings(false);
    await svc.checkAndMaybeTrigger();
    expect(stopCaffeinateMock).toHaveBeenCalledWith(STANDING);
  });

  it('re-acquires after an enable→disable→enable cycle', async() => {
    const svc = await makeParkedService();

    useSettings(true);
    await svc.checkAndMaybeTrigger();
    useSettings(false);
    await svc.checkAndMaybeTrigger();
    useSettings(true);
    await svc.checkAndMaybeTrigger();

    expect(standingStarts()).toHaveLength(2);
  });

  it('does not release when it was never held (disabled from the start)', async() => {
    useSettings(false);
    const svc = await makeParkedService();

    await svc.checkAndMaybeTrigger();

    expect(startCaffeinateMock).not.toHaveBeenCalledWith(STANDING);
    expect(stopCaffeinateMock).not.toHaveBeenCalledWith(STANDING); // guard prevents a spurious stop
  });

  it('releases the standing hold on destroy so caffeinate cannot leak', async() => {
    useSettings(true);
    const svc = await makeParkedService();
    await svc.checkAndMaybeTrigger();
    expect(startCaffeinateMock).toHaveBeenCalledWith(STANDING);

    svc.destroy();
    expect(stopCaffeinateMock).toHaveBeenCalledWith(STANDING);
  });
});
