// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { StartAttemptRecorder } from './AgentContainerStartAttempts';

export const STARTUP_RETRY_DELAYS_MS = [0, 250, 500, 1_000, 2_000, 4_000] as const;
export const MCP_PROBE_RETRY_DELAYS_MS = [0, 250, 500, 1_000, 1_500, 2_000] as const;

/** Thrown once every retry attempt is exhausted; carries the first real error, not only the last. */
export class StartupRetryError extends Error {
  readonly attempts:  readonly { attempt: number; message: string }[];
  readonly firstError: unknown;

  constructor(label: string, recorder: StartAttemptRecorder) {
    super(`${ label } failed after ${ recorder.attempts.length } attempts: ${ recorder.summary() }`, { cause: recorder.firstError });
    this.name = 'StartupRetryError';
    this.attempts = recorder.attempts;
    this.firstError = recorder.firstError;
  }
}

/** Retries an idempotent operation on a fixed delay schedule, keeping every failure's real error. */
export class IdempotentRetry {
  constructor(private readonly sleep: (delayMs: number) => Promise<void> = defaultSleep) {}

  async run<T>(
    operation: () => Promise<T>,
    delaysMs: readonly number[],
    label: string,
    onRetry?: (message: string) => void,
  ): Promise<T> {
    const recorder = new StartAttemptRecorder();

    for (let index = 0; index < delaysMs.length; index++) {
      if (delaysMs[index] > 0) await this.sleep(delaysMs[index]);
      try {
        return await operation();
      } catch (error) {
        const attempt = index + 1;
        recorder.record(attempt, error);
        if (attempt < delaysMs.length) {
          onRetry?.(`${ label } attempt ${ attempt }/${ delaysMs.length } failed: ${ this.messageOf(error) }`);
        }
      }
    }

    throw new StartupRetryError(label, recorder);
  }

  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

const defaultRetry = new IdempotentRetry();

export async function retryIdempotent<T>(
  operation: () => Promise<T>,
  delaysMs: readonly number[],
  label: string,
  onRetry?: (message: string) => void,
): Promise<T> {
  return defaultRetry.run(operation, delaysMs, label, onRetry);
}

/** Probe twice only when a real curl failure suggests the relay itself needs repair. */
export async function probeAgentMcpHost(
  probe: () => Promise<void>,
  repairRelay: () => Promise<void>,
  delaysMs: readonly number[] = MCP_PROBE_RETRY_DELAYS_MS,
  onRetry?: (message: string) => void,
): Promise<void> {
  try {
    await defaultRetry.run(probe, delaysMs, 'graph MCP probe', onRetry);
  } catch (error) {
    const cause = (error as Error & { cause?: { stderr?: string } }).cause;
    if (!cause?.stderr) throw error;
    await repairRelay();
    await defaultRetry.run(probe, delaysMs, 'graph MCP probe after relay repair', onRetry);
  }
}
