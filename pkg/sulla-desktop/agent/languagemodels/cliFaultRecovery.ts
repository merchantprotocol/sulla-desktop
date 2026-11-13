// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import {
  AuthExpired, AuthRevoked, CliExhausted, ProviderFailure, QuotaExceeded, RateLimited,
  legacyProviderFailure,
} from './failures';
import { InfrastructureFailure, ProviderBridgeDeniedFailure, isProviderBridgeDenial } from './providerRecovery';

export const CLI_RECOVERY_MAX_ATTEMPTS = 2;
export const CLI_RECOVERY_BACKOFF_MS = 750;

export type CliFaultKind = 'spawn' | 'transport' | 'process_exit' | 'stall' | 'protocol';

export class CliFaultError extends Error {
  readonly cliFault = true;
  /**
   * Set when Sulla's own plumbing caused the fault (e.g. the process handoff
   * after a background-task hold), not the provider. Read by
   * classifyLLMFailure through `code`, so it never backs the provider off.
   */
  sullaInternal = false;
  code?: string;

  constructor(
    readonly kind: CliFaultKind,
    message: string,
    cause?: unknown,
    readonly retrySafe = true,
    readonly unsafeToFallback = !retrySafe,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'CliFaultError';
  }
}

export class CliRecoveryExhaustedError extends CliExhausted {
  readonly cliRecoveryExhausted = true;
  readonly unsafeToFallback: boolean;

  constructor(readonly faultKind: CliFaultKind, cause: unknown, providerId = 'cli') {
    super(providerId, { cause });
    this.name = 'CliRecoveryExhaustedError';
    this.unsafeToFallback = Boolean((cause as any)?.unsafeToFallback);
  }
}

/** Mark a CLI fault as caused by Sulla's process/container plumbing, never the provider. */
export function markSullaInternalFault<E extends Error>(error: E): E {
  if (isCliFault(error)) {
    error.sullaInternal = true;
    error.code = 'SULLA_INFRA';
  }
  return error;
}

/**
 * Recovery ran out on faults Sulla caused while handing a conversation over
 * from a process held for background tasks. Infrastructure, so it never counts
 * against the provider and never reads as the provider failing.
 */
export class CliHandoffFailure extends InfrastructureFailure {
  readonly cliHandoffFailure = true;
  readonly unsafeToFallback: boolean;

  constructor(readonly faultKind: CliFaultKind, cause: unknown) {
    super('Sulla could not hand this chat over from the earlier background task. Send your message again.', cause);
    this.name = 'CliHandoffFailure';
    this.unsafeToFallback = Boolean((cause as any)?.unsafeToFallback);
  }
}

/** Infrastructure loss is recovered by the container lifecycle owner, not by provider failover. */
export class ContainerLifecycleLostError extends Error {
  readonly containerLifecycleLost = true;

  constructor(cause: unknown) {
    super('Agent container disappeared while starting the provider process', { cause });
    this.name = 'ContainerLifecycleLostError';
  }
}

export function isContainerLifecycleLost(error: unknown): boolean {
  let current: any = error;
  for (let depth = 0; current && depth < 6; depth++) {
    if (current.containerLifecycleLost === true || /no such container|container .* is not running/i.test(String(current.message ?? current))) return true;
    current = current.cause;
  }
  return false;
}

export const CLI_RECOVERY_PROMPT = [
  '[CLI fault recovery]',
  'The prior CLI process ended unexpectedly. Continue this same turn from the preserved session.',
  'Inspect the session and current workspace state first. Do not repeat completed tool calls or blindly replay the original instruction.',
  'If a prior tool may still be running or its outcome is uncertain, stop and report that uncertainty instead of invoking it again.',
].join(' ');

export function recoveryMessages<T extends { role: string; content: unknown }>(messages: T[]): T[] {
  const current = [...messages].reverse().find(message => message.role === 'user');
  const request = typeof current?.content === 'string'
    ? current.content
    : current?.content === undefined ? '' : JSON.stringify(current.content);
  const prompt = request
    ? `${ CLI_RECOVERY_PROMPT }\n\nCurrent user request (retain this intent; do not blindly replay completed work):\n${ request }`
    : CLI_RECOVERY_PROMPT;
  return [...messages, { role: 'user', content: prompt } as T];
}

export function isAbortFailure(error: unknown, signal?: AbortSignal): boolean {
  return !!signal?.aborted || (error as any)?.name === 'AbortError';
}

export function isCliFault(error: unknown): error is CliFaultError {
  return (error as any)?.cliFault === true;
}

export function isPermanentCliFailure(error: unknown, providerId = 'cli'): boolean {
  const failure = error instanceof ProviderFailure ? error : legacyProviderFailure(providerId, error);
  return failure instanceof AuthExpired || failure instanceof AuthRevoked ||
    failure instanceof QuotaExceeded || failure instanceof RateLimited;
}

export async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms);
    timer.unref?.();
    function done() {
      signal?.removeEventListener('abort', cancelled);
      resolve();
    }
    function cancelled() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancelled);
      reject(abortError());
    }
    signal?.addEventListener('abort', cancelled, { once: true });
  });
}

interface KillableChild {
  exitCode: number | null;
  kill(signal?: NodeJS.Signals): boolean;
}

export async function terminateCliChild(
  proc: KillableChild,
  remoteSignal: (signal: 'TERM' | 'KILL') => Promise<void>,
  graceMs = 5_000,
): Promise<void> {
  try { proc.kill('SIGTERM') } catch { /* already gone */ }
  await remoteSignal('TERM').catch(() => { /* KILL below is the required confirmation barrier */ });
  await abortableDelay(graceMs);
  try {
    if (proc.exitCode === null) proc.kill('SIGKILL');
  } catch { /* already gone */ }
  try {
    await remoteSignal('KILL');
  } catch (error) {
    throw new CliFaultError('transport', 'CLI teardown could not confirm the remote process stopped; retry is unsafe.', error, false);
  }
}

export async function waitForKillHelper(child: { once: (event: string, listener: (...args: any[]) => void) => unknown }, timeoutMs = 3_000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => finish(new Error('remote kill helper timed out')), timeoutMs);
    timeout.unref?.();
    child.once('close', (code: number | null) => code === 0 ? finish() : finish(new Error(`remote kill helper exited with code ${ code }`)));
    child.once('error', (error: Error) => finish(error));
  });
}

export async function runWithCliFaultRecovery<T>(
  providerName: string,
  operation: (attempt: number) => Promise<T>,
  options: {
    signal?:      AbortSignal;
    canRetry:     () => boolean;
    onRetry?:     (error: CliFaultError, nextAttempt: number) => void;
    maxAttempts?: number;
    backoffMs?:   number;
  },
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? CLI_RECOVERY_MAX_ATTEMPTS;
  let lastFault: CliFaultError | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (options.signal?.aborted) throw abortError();
    try {
      return await operation(attempt);
    } catch (error) {
      if (isAbortFailure(error, options.signal)) throw abortError();
      if (isContainerLifecycleLost(error)) throw new ContainerLifecycleLostError(error);
      // A denied bridge lease fails identically on every re-run: fail fast, once.
      if (isProviderBridgeDenial(error)) throw error instanceof InfrastructureFailure ? error : new ProviderBridgeDeniedFailure(error);
      if (!isCliFault(error)) throw error;
      lastFault = error;
      if (attempt >= maxAttempts) break;
      if (!error.retrySafe || !options.canRetry()) {
        if (error.unsafeToFallback) break;
        throw error;
      }
      options.onRetry?.(error, attempt + 1);
      await abortableDelay(options.backoffMs ?? CLI_RECOVERY_BACKOFF_MS, options.signal);
    }
  }

  const fault = lastFault ?? new CliFaultError('protocol', 'unknown CLI failure');
  if (fault.sullaInternal) throw new CliHandoffFailure(fault.kind, fault);
  throw new CliRecoveryExhaustedError(fault.kind, fault, providerName);
}

function abortError(): Error {
  const error = new Error('CLI run aborted');
  error.name = 'AbortError';
  return error;
}
