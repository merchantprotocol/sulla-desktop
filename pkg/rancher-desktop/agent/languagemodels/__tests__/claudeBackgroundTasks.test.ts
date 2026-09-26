/**
 * @jest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  BackgroundCompletionDelivery,
  ClaudeBackgroundTaskTracker,
  formatBackgroundNotices,
  wakeTargetFromState,
  type BackgroundTaskNotice,
} from '../claudeBackgroundTasks';

jest.mock('../../services/WebSocketClientService', () => ({ getWebSocketClientService: jest.fn() }));

// Event shapes captured from `claude -p --output-format stream-json` 2.1.282
// running `sleep 8` with run_in_background while stdin stayed open.
const started = { type: 'system', subtype: 'task_started', task_id: 'b1', is_backgrounded: true, description: 'sleep 8' };
const liveOne = { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1', description: 'sleep 8' }] };
const liveNone = { type: 'system', subtype: 'background_tasks_changed', tasks: [] };
const turnResult = { type: 'result', subtype: 'success', is_error: false, result: 'STARTED' };
const notification = {
  type:        'system',
  subtype:     'task_notification',
  task_id:     'b1',
  status:      'completed',
  output_file: '/tmp/tasks/b1.output',
  summary:     'Background command "sleep 8" completed (exit code 0)',
};
const init = { type: 'system', subtype: 'init', session_id: 's1' };
const followUpResult = { type: 'result', subtype: 'success', is_error: false, result: 'FINISHED' };

describe('ClaudeBackgroundTaskTracker', () => {
  it('tracks live tasks and emits the completion with the autonomous follow-up text', () => {
    const emitted: BackgroundTaskNotice[][] = [];
    const tracker = new ClaudeBackgroundTaskTracker(n => emitted.push(n));

    tracker.observe(liveOne, false);
    tracker.observe(started, false);
    tracker.observe(turnResult, false);
    expect(tracker.liveTaskCount).toBe(1);
    expect(emitted).toHaveLength(0);

    // Sulla's turn is over — everything below lands on a parked process.
    tracker.observe(liveNone, true);
    tracker.observe(notification, true);
    expect(tracker.liveTaskCount).toBe(0);
    expect(tracker.pendingCount).toBe(1);

    tracker.observe(init, true);
    expect(tracker.inAutonomousTurn).toBe(true);
    tracker.observe(followUpResult, true);

    expect(tracker.inAutonomousTurn).toBe(false);
    expect(emitted).toHaveLength(1);
    expect(emitted[0][0]).toMatchObject({
      taskId:       'b1',
      status:       'completed',
      outputFile:   '/tmp/tasks/b1.output',
      followUpText: 'FINISHED',
    });
    expect(tracker.pendingCount).toBe(0);
  });

  it('ignores a completion delivered inside a turn Sulla owns', () => {
    const emitted: BackgroundTaskNotice[][] = [];
    const tracker = new ClaudeBackgroundTaskTracker(n => emitted.push(n));

    tracker.observe(started, false);
    tracker.observe(notification, false);
    tracker.observe(turnResult, false);

    expect(tracker.liveTaskCount).toBe(0);
    expect(tracker.pendingCount).toBe(0);
    expect(emitted).toHaveLength(0);
  });

  it('does not treat an unrelated parked result as a completion turn', () => {
    const emitted: BackgroundTaskNotice[][] = [];
    const tracker = new ClaudeBackgroundTaskTracker(n => emitted.push(n));

    tracker.observe(init, true);
    tracker.observe(followUpResult, true);

    expect(tracker.inAutonomousTurn).toBe(false);
    expect(emitted).toHaveLength(0);
  });

  it('flush emits completions that never got a follow-up turn (stdin closed / exit)', () => {
    const emitted: BackgroundTaskNotice[][] = [];
    const tracker = new ClaudeBackgroundTaskTracker(n => emitted.push(n));

    tracker.observe(notification, true);
    tracker.flush();
    tracker.flush();

    expect(emitted).toHaveLength(1);
    expect(emitted[0][0].followUpText).toBe('');
  });
});

describe('wakeTargetFromState', () => {
  it('targets a top-level graph thread', () => {
    const state = { metadata: { wsChannel: 'sulla-desktop', threadId: 'thread_1' } };

    expect(wakeTargetFromState(state)).toEqual({ channel: 'sulla-desktop', threadId: 'thread_1', state });
  });

  it('never wakes sub-agents, observers, or states without a thread', () => {
    expect(wakeTargetFromState({ metadata: { wsChannel: 'c', threadId: 't', isSubAgent: true } })).toBeNull();
    expect(wakeTargetFromState({ metadata: { wsChannel: 'c', threadId: 't', modelSlot: 'subconscious' } })).toBeNull();
    expect(wakeTargetFromState({ metadata: { wsChannel: 'c' } })).toBeNull();
    expect(wakeTargetFromState(undefined)).toBeNull();
  });
});

function notice(taskId = 'b1'): BackgroundTaskNotice {
  return { taskId, status: 'completed', summary: `task ${ taskId } done`, followUpText: 'FINISHED', completedAt: 0 };
}

describe('BackgroundCompletionDelivery', () => {
  beforeEach(() => { jest.useFakeTimers() });
  afterEach(() => { jest.useRealTimers() });

  it('wakes an idle thread immediately with a system-sourced user_message', () => {
    const send = jest.fn(async() => {});
    const delivery = new BackgroundCompletionDelivery(send);
    const state = { metadata: { cycleComplete: true } };

    delivery.deliver('conv', { channel: 'sulla-desktop', threadId: 'thread_1', state }, [notice()]);

    expect(send).toHaveBeenCalledTimes(1);
    const [channel, payload] = send.mock.calls[0] as unknown as [string, any];
    expect(channel).toBe('sulla-desktop');
    expect(payload.type).toBe('user_message');
    expect(payload.data.threadId).toBe('thread_1');
    expect(payload.data.metadata).toMatchObject({ source: 'background_task_completion', inputSource: 'system' });
    expect(payload.data.content).toContain('task b1 done');
    expect(payload.data.content).toContain('FINISHED');
    expect(delivery.hasPending('conv')).toBe(false);
  });

  it('holds the wake while the thread is busy instead of aborting the running turn', () => {
    const send = jest.fn(async() => {});
    const delivery = new BackgroundCompletionDelivery(send);
    const state = { metadata: { cycleComplete: false } };

    delivery.deliver('conv', { channel: 'c', threadId: 't', state }, [notice()]);
    expect(send).not.toHaveBeenCalled();

    jest.advanceTimersByTime(15_000);
    expect(send).not.toHaveBeenCalled();

    state.metadata.cycleComplete = true;
    jest.advanceTimersByTime(15_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('hands held notices to the next turn instead of double-delivering', () => {
    const send = jest.fn(async() => {});
    const delivery = new BackgroundCompletionDelivery(send);
    const state = { metadata: { cycleComplete: false } };

    delivery.deliver('conv', { channel: 'c', threadId: 't', state }, [notice('a')]);
    delivery.deliver('conv', null, [notice('b')]);
    const taken = delivery.takePending('conv');

    expect(taken.map(n => n.taskId)).toEqual(['a', 'b']);
    state.metadata.cycleComplete = true;
    jest.advanceTimersByTime(60_000);
    expect(send).not.toHaveBeenCalled();
    expect(delivery.takePending('conv')).toEqual([]);
  });

  it('keeps notices for the next turn when there is no wake target', () => {
    const send = jest.fn(async() => {});
    const delivery = new BackgroundCompletionDelivery(send);

    delivery.deliver('conv', null, [notice()]);

    expect(send).not.toHaveBeenCalled();
    expect(delivery.takePending('conv')).toHaveLength(1);
  });

  it('requeues notices when the wake send fails', async() => {
    const send = jest.fn(() => Promise.reject(new Error('ws down')));
    const delivery = new BackgroundCompletionDelivery(send);

    delivery.deliver('conv', { channel: 'c', threadId: 't', state: { metadata: { cycleComplete: true } } }, [notice()]);
    await Promise.resolve();
    await Promise.resolve();

    expect(delivery.takePending('conv')).toHaveLength(1);
  });
});

describe('formatBackgroundNotices', () => {
  it('marks the message as automatic and includes output path and follow-up', () => {
    const text = formatBackgroundNotices([{ ...notice(), outputFile: '/tmp/x.output' }]);

    expect(text).toContain('[Background task finished while you were idle]');
    expect(text).toContain('/tmp/x.output');
    expect(text).toContain('FINISHED');
    expect(text).toContain('not a message typed by the human');
  });
});
