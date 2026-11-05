import { describe, expect, it } from 'vitest';
import { JobWrapUpService, type JobWrapUpMessageSender, type JobWrapUpTimer } from '../../../app/Services/JobWrapUpService';
import type { StopPrincipalValue } from '../../../app/ValueObjects/StopPrincipal';

class FakeTimer implements JobWrapUpTimer {
  private next = 0;
  readonly callbacks = new Map<number, () => void>();
  readonly cancelled: number[] = [];
  schedule(_delay: number, callback: () => void): number { const id = ++this.next; this.callbacks.set(id, callback); return id; }
  cancel(handle: number): void { this.cancelled.push(handle); this.callbacks.delete(handle); }
  elapse(): void { for (const [id, callback] of [...this.callbacks]) { this.callbacks.delete(id); callback(); } }
}

class FakeMessages implements JobWrapUpMessageSender {
  readonly sent: Array<{ jobId: string; taskIndex?: number; message: string }> = [];
  async send(input: { jobId: string; taskIndex?: number; message: string }): Promise<void> { this.sent.push(input); }
}

class FakeStops {
  readonly stopped: Array<[string, number]> = [];
  async stopTask(jobId: string, taskIndex: number): Promise<'stopped'> { this.stopped.push([jobId, taskIndex]); return 'stopped'; }
}

const principal = { kind: 'human' } as StopPrincipalValue;

describe('JobWrapUpService', () => {
  it('targets only the requested task and cancels its grace stop when it returns', async() => {
    // risk: lifecycle — a sibling worker must not receive a stop request or hard stop.
    const timer = new FakeTimer(); const messages = new FakeMessages(); const stops = new FakeStops();
    const service = new JobWrapUpService(stops as any, messages, timer);
    await service.request('job-1', [1], principal, 'reason', 1, 'return now');
    expect(messages.sent).toHaveLength(1); expect(messages.sent[0].taskIndex).toBe(1);
    service.taskSettled('job-1', 1); timer.elapse();
    expect(stops.stopped).toEqual([]); expect(timer.cancelled).toHaveLength(1);
  });

  it('hard-stops the targeted task after grace while its sibling keeps running', async() => {
    // risk: lifecycle — grace expiry must stop exactly one task, not cascade to siblings.
    const timer = new FakeTimer(); const messages = new FakeMessages(); const stops = new FakeStops();
    const service = new JobWrapUpService(stops as any, messages, timer);
    await service.request('job-1', [0], principal, 'reason', 1, 'return now');
    timer.elapse();
    expect(stops.stopped).toEqual([['job-1', 0]]);
  });
});
