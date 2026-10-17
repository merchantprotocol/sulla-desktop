export interface FailureLifecycleOptions<T> {
  isShuttingDown:        () => boolean;
  waitForLogs:           () => Promise<void>;
  getFailureDetails:     () => Promise<T | undefined>;
  showFailureDetails:    (details: T) => Promise<void> | void;
  showFallback:          () => void;
  onFailureDetailsError: (error: unknown) => void;
}

export async function reportFailureUnlessShuttingDown<T>(options: FailureLifecycleOptions<T>): Promise<void> {
  if (options.isShuttingDown()) {
    return;
  }

  try {
    await options.waitForLogs();
    if (options.isShuttingDown()) {
      return;
    }

    const failureDetails = await options.getFailureDetails();

    if (options.isShuttingDown()) {
      return;
    }
    if (failureDetails) {
      await options.showFailureDetails(failureDetails);

      return;
    }
  } catch (error) {
    options.onFailureDetailsError(error);
  }

  if (options.isShuttingDown()) {
    return;
  }
  options.showFallback();
}
