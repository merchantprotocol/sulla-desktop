import { jest } from '@jest/globals';

import { reportFailureUnlessShuttingDown } from '@pkg/main/failureLifecycle';

function deferred<T>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });

  return { promise, resolve: settle };
}

describe('failure reporting lifecycle', () => {
  it('does not report a failure when shutdown starts during an asynchronous boundary', async() => {
    for (const boundary of ['log wait', 'failure details'] as const) {
      let shuttingDown = false;
      const logWait = deferred<void>();
      const details = deferred<{ message: string } | undefined>();
      const getFailureDetails = jest.fn(() => details.promise);
      const showFailureDetails = jest.fn<(details: { message: string }) => void>();
      const showFallback = jest.fn<() => void>();
      const reporting = reportFailureUnlessShuttingDown({
        isShuttingDown:        () => shuttingDown,
        waitForLogs:           () => logWait.promise,
        getFailureDetails,
        showFailureDetails,
        showFallback,
        onFailureDetailsError: jest.fn(),
      });

      if (boundary === 'log wait') {
        shuttingDown = true;
        logWait.resolve();
      } else {
        logWait.resolve();
        await Promise.resolve();
        expect(getFailureDetails).toHaveBeenCalledTimes(1);
        shuttingDown = true;
        details.resolve({ message: 'late failure' });
      }

      await reporting;
      expect(showFailureDetails).not.toHaveBeenCalled();
      expect(showFallback).not.toHaveBeenCalled();
    }
  });
});
