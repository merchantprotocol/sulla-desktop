// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { StartAttemptRecorder } from '../../../../services/AgentContainerStartAttempts';
import { IdempotentRetry, probeAgentMcpHost, StartupRetryError } from '../../../../services/AgentContainerStartupRetry';

class FakeSleeper {
  calls: number[] = [];
  readonly sleep = async(delayMs: number): Promise<void> => { this.calls.push(delayMs) };
}

const containerGoneError = (id: string) => new Error(`sulla-runtime exec docker start ${ id } exited 1: Error response from daemon: No such container: ${ id }`);

describe('StartAttemptRecorder', () => {
  it('summarizes a real first failure followed by the container being auto-removed', () => {
    // risk: operators only ever see "No such container" and never learn the container actually crashed on boot
    const recorder = new StartAttemptRecorder();
    recorder.record(1, new Error('OCI runtime create failed: exec format error'));
    for (let attempt = 2; attempt <= 6; attempt++) recorder.record(attempt, containerGoneError('abc123'));

    const summary = recorder.summary();

    expect(summary).toContain('OCI runtime create failed: exec format error');
    expect(summary.startsWith('container exited during start and was removed:')).toBe(true);
    expect(summary).toContain('attempts 2-6');
    expect(summary).not.toBe('No such container');
  });

  it('dedupes identical errors across every attempt into one ranged entry', () => {
    // risk: a flood of duplicate retry lines burying the one fact that matters
    const recorder = new StartAttemptRecorder();
    for (let attempt = 1; attempt <= 6; attempt++) recorder.record(attempt, containerGoneError('xyz789'));

    const summary = recorder.summary();

    expect(summary).toBe('attempts 1-6: sulla-runtime exec docker start xyz789 exited 1: Error response from daemon: No such container: xyz789');
    expect(summary).not.toBe('No such container');
  });

  it('handles non-Error throwables', () => {
    // risk: a thrown string (not an Error) crashes the recorder instead of being reported
    const recorder = new StartAttemptRecorder();
    recorder.record(1, 'boom');
    recorder.record(2, 'boom');

    expect(recorder.summary()).toBe('attempts 1-2: boom');
    expect(recorder.firstError).toBe('boom');
  });

  it('exposes attempts in order with their messages', () => {
    const recorder = new StartAttemptRecorder();
    recorder.record(1, new Error('first'));
    recorder.record(2, new Error('second'));

    expect(recorder.attempts).toEqual([
      { attempt: 1, message: 'first' },
      { attempt: 2, message: 'second' },
    ]);
  });
});

describe('IdempotentRetry', () => {
  it('resolves without throwing when a later attempt succeeds', async() => {
    // risk: a transient hiccup on attempt 1 wrongly fails the whole container launch
    const sleeper = new FakeSleeper();
    const retry = new IdempotentRetry(sleeper.sleep);
    let calls = 0;
    const operation = async() => {
      calls += 1;
      if (calls === 1) throw new Error('transient');
      return 'started';
    };

    const result = await retry.run(operation, [0, 10], 'agent container start');

    expect(result).toBe('started');
    expect(calls).toBe(2);
  });

  it('throws a StartupRetryError carrying the first error as cause once every attempt fails', async() => {
    // risk: StartupRetryError loses the real root cause (first error) once retries are exhausted
    const sleeper = new FakeSleeper();
    const retry = new IdempotentRetry(sleeper.sleep);
    let attempt = 0;
    const operation = async() => {
      attempt += 1;
      throw attempt === 1
        ? new Error('OCI runtime create failed: exec format error')
        : containerGoneError('abc123');
    };

    await expect(retry.run(operation, [0, 0, 0, 0, 0, 0], 'agent container start')).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(StartupRetryError);
      const startupError = error as StartupRetryError;
      expect(startupError.message).toContain('agent container start failed after 6 attempts');
      expect(startupError.message).toContain('OCI runtime create failed: exec format error');
      expect((startupError.cause as Error).message).toContain('OCI runtime create failed');
      expect(startupError.firstError).toBe(startupError.cause);
      expect(startupError.attempts).toHaveLength(6);
      return true;
    });
  });

  it('invokes onRetry for every attempt before the last', async() => {
    const sleeper = new FakeSleeper();
    const retry = new IdempotentRetry(sleeper.sleep);
    const retryMessages: string[] = [];
    const operation = async() => { throw new Error('nope') };

    await expect(retry.run(operation, [0, 0, 0], 'probe', message => retryMessages.push(message))).rejects.toThrow();

    expect(retryMessages).toHaveLength(2);
    expect(retryMessages[0]).toContain('probe attempt 1/3 failed: nope');
  });
});

describe('probeAgentMcpHost', () => {
  it('repairs the relay and retries once the probe failure carries real curl stderr', async() => {
    // risk: a broken host relay is never repaired because the real failure's stderr is lost
    let probeCalls = 0;
    let repaired = false;
    const probe = async() => {
      probeCalls += 1;
      if (probeCalls <= 2) {
        const error = new Error('curl exited 7') as Error & { stderr: string };
        error.stderr = 'curl: (7) Failed to connect';
        throw error;
      }
    };
    const repairRelay = async() => { repaired = true };

    await probeAgentMcpHost(probe, repairRelay, [0, 0]);

    expect(repaired).toBe(true);
    expect(probeCalls).toBe(3);
  });

  it('does not attempt relay repair when the probe failure carries no stderr', async() => {
    // risk: repairing the relay on every unrelated failure masks the real problem
    let repaired = false;
    const probe = async() => { throw new Error('ECONNREFUSED') };
    const repairRelay = async() => { repaired = true };

    await expect(probeAgentMcpHost(probe, repairRelay, [0, 0])).rejects.toThrow('ECONNREFUSED');
    expect(repaired).toBe(false);
  });
});
