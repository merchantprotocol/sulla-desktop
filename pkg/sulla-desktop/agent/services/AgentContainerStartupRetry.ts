// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export const STARTUP_RETRY_DELAYS_MS = [0, 250, 500, 1_000, 2_000, 4_000] as const;
export const MCP_PROBE_RETRY_DELAYS_MS = [0, 250, 500, 1_000, 1_500, 2_000] as const;

const sleep = (delayMs: number): Promise<void> => new Promise(resolve => setTimeout(resolve, delayMs));

export async function retryIdempotent<T>(
  operation: () => Promise<T>,
  delaysMs: readonly number[],
  label: string,
  onRetry?: (message: string) => void,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < delaysMs.length; attempt++) {
    if (delaysMs[attempt] > 0) await sleep(delaysMs[attempt]);
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt + 1 < delaysMs.length) {
        onRetry?.(`${ label } attempt ${ attempt + 1 }/${ delaysMs.length } failed: ${ (error as Error).message }`);
      }
    }
  }

  throw new Error(`${ label } failed after ${ delaysMs.length } attempts: ${ (lastError as Error).message }`, { cause: lastError });
}

/** Probe twice only when a real curl failure suggests the relay itself needs repair. */
export async function probeAgentMcpHost(
  probe: () => Promise<void>,
  repairRelay: () => Promise<void>,
  delaysMs: readonly number[] = MCP_PROBE_RETRY_DELAYS_MS,
  onRetry?: (message: string) => void,
): Promise<void> {
  try {
    await retryIdempotent(probe, delaysMs, 'graph MCP probe', onRetry);
  } catch (error) {
    const cause = (error as Error & { cause?: { stderr?: string } }).cause;
    if (!cause?.stderr) throw error;
    await repairRelay();
    await retryIdempotent(probe, delaysMs, 'graph MCP probe after relay repair', onRetry);
  }
}
