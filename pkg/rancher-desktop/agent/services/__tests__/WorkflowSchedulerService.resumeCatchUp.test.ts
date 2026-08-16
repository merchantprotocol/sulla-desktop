import { describe, expect, it, jest } from '@jest/globals';

import { WorkflowSchedulerService } from '../WorkflowSchedulerService';

// resumeCatchUp() is the power-`resume` recovery entry point. On wake from
// macOS sleep the same process resumes, so boot catch-up (`initialize`) is
// already `initialized`-guarded and does nothing — node-schedule's frozen
// in-process timers silently recompute forward and any cron that tripped
// while asleep is lost. resumeCatchUp must therefore re-arm schedules AND
// run the missed-fire scan every time it is called, regardless of the
// `initialized` flag.
describe('WorkflowSchedulerService.resumeCatchUp', () => {
  const stub = (svc: WorkflowSchedulerService) => {
    const calls: string[] = [];
    const scan = jest.fn(async () => { calls.push('scanAndSchedule'); });
    const catchUp = jest.fn(async () => { calls.push('catchUpMissedFires'); });
    // Both are private; replace them on the instance for the test.
    (svc as unknown as Record<string, unknown>).scanAndSchedule = scan;
    (svc as unknown as Record<string, unknown>).catchUpMissedFires = catchUp;
    return { calls, scan, catchUp };
  };

  it('re-arms schedules then runs the missed-fire scan, in that order', async () => {
    const svc = new WorkflowSchedulerService();
    const { calls, scan, catchUp } = stub(svc);

    await svc.resumeCatchUp();

    expect(scan).toHaveBeenCalledTimes(1);
    expect(catchUp).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['scanAndSchedule', 'catchUpMissedFires']);
  });

  it('runs even after initialize() has already set the initialized guard', async () => {
    const svc = new WorkflowSchedulerService();
    // Simulate an already-booted service: the initialized flag is set, which
    // would short-circuit initialize() — resumeCatchUp must NOT be gated by it.
    (svc as unknown as Record<string, unknown>).initialized = true;
    const { scan, catchUp } = stub(svc);

    await svc.resumeCatchUp();

    expect(scan).toHaveBeenCalledTimes(1);
    expect(catchUp).toHaveBeenCalledTimes(1);
  });
});
