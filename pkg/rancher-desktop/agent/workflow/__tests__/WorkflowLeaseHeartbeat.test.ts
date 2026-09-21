/** @jest-environment node */
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { WorkflowLeaseHeartbeat, WorkflowLeaseLostError } from '../WorkflowLeaseHeartbeat';

afterEach(() => { jest.useRealTimers(); });

describe('workflow ownership during long-running nodes', () => {
  it('keeps a ten-minute node alive beyond the 60-second recovery lease', async() => {
    jest.useFakeTimers();
    let expires = Date.now() + 60_000;
    let recoveries = 0;
    const lost = jest.fn();
    const heartbeat = new WorkflowLeaseHeartbeat(async() => {
      if (expires <= Date.now()) return false;
      expires = Date.now() + 60_000;
      return true;
    }, lost);
    heartbeat.start();
    for (let minute = 0; minute < 10; minute++) {
      await jest.advanceTimersByTimeAsync(60_000);
      if (expires <= Date.now()) recoveries++;
    }
    expect(recoveries).toBe(0);
    expect(lost).not.toHaveBeenCalled();
    heartbeat.stop();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('fences checkpoints and downstream work after a terminal or stolen lease', async() => {
    jest.useFakeTimers();
    let owned = true;
    const lost = jest.fn();
    const heartbeat = new WorkflowLeaseHeartbeat(async() => owned, lost);
    heartbeat.start();
    owned = false;
    await jest.advanceTimersByTimeAsync(15_000);
    await expect(heartbeat.assertOwned()).rejects.toBeInstanceOf(WorkflowLeaseLostError);
    expect(lost).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('fails closed on a hung database renewal before the lease expires', async() => {
    jest.useFakeTimers();
    const lost = jest.fn();
    const heartbeat = new WorkflowLeaseHeartbeat(() => new Promise(() => {}), lost);
    heartbeat.start();
    await jest.advanceTimersByTimeAsync(25_000);
    expect(lost).toHaveBeenCalledTimes(1);
    await expect(heartbeat.assertOwned()).rejects.toThrow('timed out');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('shares one in-flight renewal between the timer and foreground checks', async() => {
    jest.useFakeTimers();
    let resolve!: (owned: boolean) => void;
    const renew = jest.fn<() => Promise<boolean>>(() => new Promise(done => { resolve = done; }));
    const heartbeat = new WorkflowLeaseHeartbeat(renew, jest.fn());
    heartbeat.start();
    await jest.advanceTimersByTimeAsync(15_000);
    const boundary = heartbeat.assertOwned();
    expect(renew).toHaveBeenCalledTimes(1);
    resolve(true);
    await boundary;
    heartbeat.stop();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not abort after normal settlement races with an in-flight renewal', async() => {
    jest.useFakeTimers();
    let resolve!: (owned: boolean) => void;
    const lost = jest.fn();
    const heartbeat = new WorkflowLeaseHeartbeat(() => new Promise(done => { resolve = done; }), lost);
    heartbeat.start();
    await jest.advanceTimersByTimeAsync(15_000);
    heartbeat.stop();
    resolve(false);
    await jest.advanceTimersByTimeAsync(0);
    expect(lost).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
});
