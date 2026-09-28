/**
 * Early wake: a human comment should not wait out the whole Heartbeat
 * interval, but it must still honour the enabled switch and never start a
 * second run on top of one already executing.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const getSettingMock: any = jest.fn();

jest.unstable_mockModule('../../../main/SleepPreventionService', () => ({
  startCaffeinate: jest.fn(),
  stopCaffeinate:  jest.fn(),
  scheduleWake:    jest.fn(),
}));
jest.unstable_mockModule('../../database/models/SullaSettingsModel', () => ({
  SullaSettingsModel: { get: getSettingMock, set: jest.fn(() => Promise.resolve()) },
}));

function useSettings(enabled: boolean) {
  getSettingMock.mockImplementation((key: string, dflt: unknown) => {
    if (key === 'heartbeatEnabled') return Promise.resolve(enabled);
    if (key === 'heartbeatWindow') return Promise.resolve(null);
    return Promise.resolve(dflt);
  });
}

async function makeService(): Promise<any> {
  const { HeartbeatService } = await import('../HeartbeatService');
  const svc: any = new HeartbeatService();
  svc.initialized = true;
  svc.lastTriggerMs = Date.now(); // interval not due
  svc.triggerHeartbeat = jest.fn(() => Promise.resolve());
  return svc;
}

describe('HeartbeatService.requestWake', () => {
  beforeEach(() => getSettingMock.mockReset());

  it('runs at the next minute check instead of waiting out the interval, once', async() => {
    useSettings(true);
    const svc = await makeService();

    await svc.checkAndMaybeTrigger();
    expect(svc.triggerHeartbeat).not.toHaveBeenCalled();

    svc.requestWake('human commented on task t1');
    await svc.checkAndMaybeTrigger();
    await svc.checkAndMaybeTrigger();
    expect(svc.triggerHeartbeat).toHaveBeenCalledTimes(1);
  });

  it('keeps the request while a run is executing and fires once it is idle', async() => {
    useSettings(true);
    const svc = await makeService();
    svc.isExecuting = true;

    svc.requestWake('human commented on task t1');
    await svc.checkAndMaybeTrigger();
    expect(svc.triggerHeartbeat).not.toHaveBeenCalled();

    svc.isExecuting = false;
    svc.lastTriggerMs = Date.now(); // the busy run just finished
    await svc.checkAndMaybeTrigger();
    expect(svc.triggerHeartbeat).toHaveBeenCalledTimes(1);
  });

  it('does nothing while Heartbeat is disabled', async() => {
    useSettings(false);
    const svc = await makeService();

    svc.requestWake('human commented on task t1');
    await svc.checkAndMaybeTrigger();
    expect(svc.triggerHeartbeat).not.toHaveBeenCalled();
  });
});
