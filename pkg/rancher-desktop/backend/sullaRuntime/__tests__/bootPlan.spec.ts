/** @jest-environment node */
import { describe, expect, jest, test } from '@jest/globals';

import { bootSullaRuntimeOrFallBack, planSullaRuntimeBoot } from '../bootPlan';

const log = { warn: jest.fn(), error: jest.fn() };

describe('Sulla runtime boot fallback', () => {
  test('only a requested macOS launch without Kubernetes tries the runtime', () => {
    expect(planSullaRuntimeBoot({ requested: false, platform: 'darwin', kubernetesEnabled: false })).toEqual({ runtime: 'lima' });
    expect(planSullaRuntimeBoot({ requested: true, platform: 'linux', kubernetesEnabled: false }).runtime).toBe('lima');
    expect(planSullaRuntimeBoot({ requested: true, platform: 'darwin', kubernetesEnabled: true }).runtime).toBe('lima');
    expect(planSullaRuntimeBoot({ requested: true, platform: 'darwin', kubernetesEnabled: false })).toEqual({ runtime: 'sulla' });
  });

  test('a failure before Docker-ready stops the runtime and restores Lima, even if cleanup fails', async() => {
    const stopAndRestoreLima = jest.fn(() => Promise.reject(new Error('stop failed')));
    const result = await bootSullaRuntimeOrFallBack({
      startThroughDockerReady: () => Promise.reject(new Error('Docker was not ready after 60s')),
      stopAndRestoreLima,
      log,
    });

    expect(result).toEqual({ booted: false, reason: 'Docker was not ready after 60s' });
    expect(stopAndRestoreLima).toHaveBeenCalledTimes(1);
  });

  test('a runtime that reaches Docker-ready is kept', async() => {
    const stopAndRestoreLima = jest.fn(() => Promise.resolve());
    const result = await bootSullaRuntimeOrFallBack({ startThroughDockerReady: () => Promise.resolve(), stopAndRestoreLima, log });

    expect(result).toEqual({ booted: true });
    expect(stopAndRestoreLima).not.toHaveBeenCalled();
  });
});
