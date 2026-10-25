export type SullaRuntimeBootPlan =
  | { runtime: 'sulla' }
  | { runtime: 'lima'; reason?: string };

/** Whether this launch should try the native runtime; the reason says why not when it was requested. */
export function planSullaRuntimeBoot(input: {
  requested:         boolean;
  platform:          NodeJS.Platform;
  kubernetesEnabled: boolean;
}): SullaRuntimeBootPlan {
  if (!input.requested) {
    return { runtime: 'lima' };
  }
  if (input.platform !== 'darwin') {
    return { runtime: 'lima', reason: 'the Sulla runtime is macOS-only' };
  }
  if (input.kubernetesEnabled) {
    return { runtime: 'lima', reason: 'Kubernetes is not supported on the Sulla runtime yet' };
  }

  return { runtime: 'sulla' };
}

export type SullaRuntimeBootResult = { booted: true } | { booted: false; reason: string };

/**
 * Start the runtime through Docker-ready. Any failure up to that point
 * (missing artifacts, start error, timeout) stops the runtime and restores
 * Lima's limactl and Docker client, so the caller can boot Lima in the same
 * launch without both ever running. Failures after Docker-ready are not
 * handled here: containers have already started on the runtime's data.
 */
export async function bootSullaRuntimeOrFallBack(steps: {
  startThroughDockerReady: () => Promise<void>;
  stopAndRestoreLima:      () => Promise<void>;
  log:                     Pick<Console, 'warn' | 'error'>;
}): Promise<SullaRuntimeBootResult> {
  try {
    await steps.startThroughDockerReady();

    return { booted: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    steps.log.warn(`[sulla-runtime] falling back to Lima: ${ reason }`);
    try {
      await steps.stopAndRestoreLima();
    } catch (cleanupError) {
      steps.log.error('[sulla-runtime] cleanup before the Lima fallback failed:', cleanupError);
    }

    return { booted: false, reason };
  }
}
