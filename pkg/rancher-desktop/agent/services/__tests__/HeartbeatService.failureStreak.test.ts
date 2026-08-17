/**
 * Consecutive-failure escalation regression tests.
 *
 * The bug: the 2026-08-14 provider outage killed ~151 heartbeat cycles in a
 * row over 43 hours and no human was ever notified — the routine digest
 * watches workflow routines, not HeartbeatService. These tests pin the fix:
 * a streak of failed cycles fires exactly one Electron-native notification
 * at the threshold (=== latch, so it cannot re-fire every cycle), re-pings
 * on the long-outage interval, is reset by a successful cycle, and ignores
 * aborted cycles.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const startCaffeinateMock: any = jest.fn();
const stopCaffeinateMock: any = jest.fn();
const getSettingMock: any = jest.fn(() => Promise.resolve(null));
const executeMock: any = jest.fn();
const notifyCreateMock: any = jest.fn(() => Promise.resolve('notified'));
const recordRunAuditMock: any = jest.fn(() => Promise.resolve());

// ESM: jest.unstable_mockModule + dynamic import (see the standingCaffeine tests).
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
jest.unstable_mockModule('../../database/models/HeartbeatRunAuditModel', () => ({
  HeartbeatRunAuditModel: {
    record: recordRunAuditMock,
  },
}));
jest.unstable_mockModule('../GraphRegistry', () => ({
  GraphRegistry: {
    getOrCreateOverlordGraph: jest.fn(() => Promise.resolve({
      graph: { execute: executeMock },
      state: { metadata: {}, messages: [] },
    })),
  },
}));
jest.unstable_mockModule('@pkg/main/chromeApi', () => ({
  getChromeApi: () => ({ notifications: { create: notifyCreateMock } }),
}));

async function makeService(): Promise<any> {
  const { HeartbeatService } = await import('../HeartbeatService');
  const svc: any = new HeartbeatService();
  svc.initialized = true;
  return svc;
}

describe('HeartbeatService consecutive-failure escalation', () => {
  beforeEach(() => {
    executeMock.mockReset();
    notifyCreateMock.mockReset();
    recordRunAuditMock.mockReset();
    notifyCreateMock.mockImplementation(() => Promise.resolve('notified'));
    recordRunAuditMock.mockImplementation(() => Promise.resolve());
  });

  it('notifies exactly once when the streak reaches the threshold, not on every later failure', async() => {
    executeMock.mockRejectedValue(new Error('HTTP 402 balance exhausted'));
    const svc = await makeService();

    await svc.triggerHeartbeat();
    await svc.triggerHeartbeat();
    expect(notifyCreateMock).not.toHaveBeenCalled(); // below threshold

    await svc.triggerHeartbeat();
    expect(notifyCreateMock).toHaveBeenCalledTimes(1);
    const [id, opts] = notifyCreateMock.mock.calls[0];
    expect(id).toBe('heartbeat-consecutive-failures');
    expect(opts.message).toContain('3 consecutive');
    expect(opts.message).toContain('HTTP 402 balance exhausted');

    await svc.triggerHeartbeat(); // 4th failure — latch already fired
    expect(notifyCreateMock).toHaveBeenCalledTimes(1);
  });

  it('re-pings on the long-outage interval while failures persist', async() => {
    executeMock.mockRejectedValue(new Error('still down'));
    const svc = await makeService();

    for (let i = 0; i < 25; i++) await svc.triggerHeartbeat();

    // Fired at 3 (threshold) and 25 (re-ping interval), nowhere else.
    expect(notifyCreateMock).toHaveBeenCalledTimes(2);
    expect(notifyCreateMock.mock.calls[1][1].message).toContain('25 consecutive');
  });

  it('a successful cycle resets the streak and re-arms the latch', async() => {
    const svc = await makeService();

    executeMock.mockRejectedValue(new Error('down'));
    await svc.triggerHeartbeat();
    await svc.triggerHeartbeat();
    await svc.triggerHeartbeat();
    expect(notifyCreateMock).toHaveBeenCalledTimes(1);

    executeMock.mockResolvedValue(undefined); // recovery
    await svc.triggerHeartbeat();
    expect(svc.consecutiveFailures).toBe(0);

    executeMock.mockRejectedValue(new Error('down again'));
    await svc.triggerHeartbeat();
    await svc.triggerHeartbeat();
    expect(notifyCreateMock).toHaveBeenCalledTimes(1); // new streak below threshold
    await svc.triggerHeartbeat();
    expect(notifyCreateMock).toHaveBeenCalledTimes(2); // latch re-armed after reset
  });

  it('aborted cycles do not count toward the streak', async() => {
    const svc = await makeService();

    executeMock.mockImplementation(() => {
      svc.activeAbort.abort();
      return Promise.reject(new Error('socket killed by abort'));
    });
    await svc.triggerHeartbeat();
    await svc.triggerHeartbeat();
    await svc.triggerHeartbeat();

    expect(svc.consecutiveFailures).toBe(0);
    expect(notifyCreateMock).not.toHaveBeenCalled();
  });

  it('a broken notification path does not throw out of the cycle error handler', async() => {
    executeMock.mockRejectedValue(new Error('down'));
    notifyCreateMock.mockImplementation(() => Promise.reject(new Error('renderer gone')));
    const svc = await makeService();

    await svc.triggerHeartbeat();
    await svc.triggerHeartbeat();
    await expect(svc.triggerHeartbeat()).resolves.toBeUndefined();
    expect(svc.consecutiveFailures).toBe(3);
  });

  it('records selected workboard task audit metadata on completed heartbeat runs', async() => {
    executeMock.mockImplementation((state: any) => {
      state.metadata.agent = {
        status:      'done',
        status_note: 'Patched the run-to-task audit trail.',
      };
      state.metadata.agentLoopCount = 2;
      state.metadata.heartbeatSelectedTaskId = 'WtS3';
      state.metadata.heartbeatWorkboardSnapshot = {
        taskId:       'WtS3',
        projectId:    'proj1',
        epicId:       'epic1',
        status:       'in_progress',
        assignee:     'heartbeat',
        lastMovedAt:  '2026-08-17T16:30:00.000Z',
        commentCount: 5,
        capturedAtMs: 1786984200000,
      };
      return Promise.resolve();
    });
    const svc = await makeService();

    await svc.triggerHeartbeat();

    const completed = svc.getHistory(10).find((event: any) => event.type === 'heartbeat_completed');
    expect(completed?.meta).toMatchObject({
      cycleCount: 2,
      status:     'done',
      focus:      'Patched the run-to-task audit trail.',
      workboard:  {
        selectedTaskId:           'WtS3',
        selectedTaskStatus:       'in_progress',
        selectedTaskAssignee:     'heartbeat',
        selectedTaskLastMovedAt:  '2026-08-17T16:30:00.000Z',
        selectedTaskCommentCount: 5,
      },
    });
    expect(recordRunAuditMock).toHaveBeenCalledTimes(2);
    expect(recordRunAuditMock.mock.calls[0][0]).toMatchObject({
      eventType: 'started',
      runId:     expect.stringMatching(/^heartbeat_\d+$/),
    });
    expect(recordRunAuditMock.mock.calls[1][0]).toMatchObject({
      eventType:                    'completed',
      status:                       'done',
      statusNote:                   'Patched the run-to-task audit trail.',
      cycleCount:                   2,
      selectedProjectId:            'proj1',
      selectedEpicId:               'epic1',
      selectedTaskId:               'WtS3',
      selectedTaskStatus:           'in_progress',
      selectedTaskAssignee:         'heartbeat',
      selectedTaskLastMovedAt:      '2026-08-17T16:30:00.000Z',
      selectedTaskCommentCount:     5,
    });
  });
});
