/**
 * @jest-environment node
 */
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { ClaudeCodeService } from '../ClaudeCodeService';

// Same lightweight stubs as ClaudeCodeService.claimPrewarm.test.ts — these
// suites only exercise the in-memory warm pool, never a real spawn.
jest.mock('@pkg/main/MCPServerHost', () => ({ getMCPServerHost: jest.fn() }));
jest.mock('../../database/RedisClient', () => ({
  redisClient: { get: jest.fn(), set: jest.fn(async() => {}), del: jest.fn() },
}));
jest.mock('@pkg/utils/logging', () => {
  const noopLog = { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} };

  return { __esModule: true, default: new Proxy({}, { get: () => noopLog }) };
});
jest.mock('@pkg/utils/paths', () => ({
  __esModule: true,
  default:    { limactl: '/dev/null', lima: '/dev/null', sullaHome: '/tmp', sullaConfig: '/tmp' },
}));
jest.mock('../../services/WebSocketClientService', () => ({ getWebSocketClientService: jest.fn() }));

/**
 * A parked warm process must keep reading its output: when a background task
 * (Bash run_in_background / Monitor) finishes after the turn, the CLI emits a
 * task_notification and runs an autonomous follow-up turn. Before this fix the
 * stream was paused, the process was reaped after 5 idle minutes (killing the
 * task), and a buffered `result` was discarded as stale on the next claim.
 */

function makeProc() {
  const proc: any = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough();
  proc.kill = jest.fn();
  proc.exitCode = null;

  return proc;
}

function makeRecord(proc = makeProc()) {
  return {
    proc,
    mcpSession:    null,
    mcpConfigPath: null,
    model:         'claude-code',
    createdAt:     Date.now(),
    closed:        false,
    busy:          false,
    reapTimer:     null as any,
  } as any;
}

const line = (o: unknown) => `${ JSON.stringify(o) }\n`;
const flush = () => new Promise(resolve => setImmediate(resolve));

const liveOne = { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1' }] };
const notification = { type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'completed', summary: 'sleep done' };
const init = { type: 'system', subtype: 'init', session_id: 's1' };
const followUp = { type: 'result', is_error: false, result: 'FINISHED' };

describe('ClaudeCodeService — background tasks on parked processes', () => {
  let service: ClaudeCodeService;
  let deliver: jest.Mock;

  beforeEach(() => {
    service = new ClaudeCodeService();
    deliver = jest.fn();
    (service as any).bgDelivery = { deliver, takePending: () => [] };
  });

  afterEach(() => {
    for (const rec of (service as any).prewarmed.values()) {
      if (rec.reapTimer) clearTimeout(rec.reapTimer);
    }
  });

  it('routes a completion + autonomous follow-up turn from a parked process to the graph', async() => {
    const rec = makeRecord();
    rec.wakeTarget = { channel: 'sulla-desktop', threadId: 't1', state: {} };
    (service as any).prewarmed.set('conv', rec);
    (service as any).parkProcess(rec, 'conv', JSON.stringify(liveOne).slice(0, 10));

    // The carried partial line is completed by the next chunk.
    rec.proc.stdout.write(`${ JSON.stringify(liveOne).slice(10) }\n`);
    rec.proc.stdout.write(line(notification) + line(init) + line(followUp));
    await flush();

    expect(deliver).toHaveBeenCalledTimes(1);
    const [convId, target, notices] = deliver.mock.calls[0] as any[];
    expect(convId).toBe('conv');
    expect(target).toEqual(rec.wakeTarget);
    expect(notices[0]).toMatchObject({ taskId: 'b1', summary: 'sleep done', followUpText: 'FINISHED' });
  });

  it('delivers an announced completion when the parked process exits without a follow-up turn', async() => {
    const rec = makeRecord();
    (service as any).parkProcess(rec, 'conv');
    rec.proc.once('exit', () => rec.bgTracker?.flush());

    rec.proc.stdout.write(line(notification));
    await flush();
    expect(deliver).not.toHaveBeenCalled();

    rec.proc.emit('exit', 0);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('adopts a parked process without discarding it over a completion-turn result', async() => {
    const rec = makeRecord();
    (service as any).prewarmed.set('conv', rec);
    (service as any).parkProcess(rec, 'conv');
    rec.proc.stdout.write(line(notification) + line(init) + line(followUp) + '{"type":"sys');
    await flush();

    const claimed = (service as any).claimPrewarm('conv', 'claude-code');

    expect(claimed).toBe(rec);
    expect(rec.proc.kill).not.toHaveBeenCalled();
    expect(rec.parkedStdout).toBeUndefined();
    expect(rec.proc.stdout.listenerCount('data')).toBe(0);
    expect(rec.proc.stdout.isPaused()).toBe(true);
    expect(claimed.pendingStdout).toBe('{"type":"sys');
  });

  describe('idle reap', () => {
    beforeEach(() => { jest.useFakeTimers() });
    afterEach(() => { jest.useRealTimers() });

    it('defers the reap while background tasks are live, then reaps once they finish', () => {
      const rec = makeRecord();
      (service as any).prewarmed.set('conv', rec);
      (service as any).ensureBackgroundTracker(rec, 'conv').observe(liveOne, false);
      (service as any).armParkedReap(rec, 'conv');

      jest.advanceTimersByTime(5 * 60_000);
      expect(rec.proc.kill).not.toHaveBeenCalled();
      expect((service as any).prewarmed.get('conv')).toBe(rec);

      rec.bgTracker.observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [] }, true);
      jest.advanceTimersByTime(5 * 60_000);
      expect(rec.proc.kill).toHaveBeenCalled();
      expect((service as any).prewarmed.has('conv')).toBe(false);
    });

    it('reaps an idle process with no background work on the normal schedule', () => {
      const rec = makeRecord();
      (service as any).prewarmed.set('conv', rec);
      (service as any).armParkedReap(rec, 'conv');

      jest.advanceTimersByTime(5 * 60_000);
      expect(rec.proc.kill).toHaveBeenCalled();
    });

    it('stops deferring at the 4h ceiling', () => {
      const rec = makeRecord();
      (service as any).prewarmed.set('conv', rec);
      (service as any).ensureBackgroundTracker(rec, 'conv').observe(liveOne, false);
      (service as any).armParkedReap(rec, 'conv');

      jest.advanceTimersByTime(4 * 60 * 60_000 - 1);
      expect(rec.proc.kill).not.toHaveBeenCalled();
      jest.advanceTimersByTime(10 * 60_000);
      expect(rec.proc.kill).toHaveBeenCalled();
    });
  });

  it('waits for an in-flight autonomous turn before a new turn adopts the process', async() => {
    const rec = makeRecord();
    (service as any).prewarmed.set('conv', rec);
    (service as any).parkProcess(rec, 'conv');
    rec.proc.stdout.write(line(notification) + line(init));
    await flush();
    expect(rec.bgTracker.inAutonomousTurn).toBe(true);

    let waited = false;
    const wait = (service as any).waitForAutonomousTurn('conv').then(() => { waited = true });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(waited).toBe(false);

    rec.proc.stdout.write(line(followUp));
    await wait;
    expect(waited).toBe(true);
    expect((service as any).prewarmed.get('conv')).toBe(rec);
    expect(rec.proc.kill).not.toHaveBeenCalled();
  });
});
