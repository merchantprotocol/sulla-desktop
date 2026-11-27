// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { performance } from 'node:perf_hooks';

export interface LoopProviderResolutionOptions {
  /** Maximum active time spent resolving the provider, including retries. */
  timeoutMs?: number;
  /** Bound one attempt so transient failures still leave time for retries. */
  attemptTimeoutMs?: number;
  maxAttempts?: number;
  retryBackoffMs?: number[];
}

export interface LoopProviderResolutionAttempt {
  signal: AbortSignal;
  stage<T>(name: string, work: () => Promise<T>): Promise<T>;
}

export class LoopProviderResolutionError extends Error {
  constructor(
    readonly stage: string,
    readonly attempts: number,
    readonly timeoutMs: number,
    readonly timedOut: boolean,
  ) {
    super(`Loop provider resolution ${ timedOut ? 'timed out' : 'failed' } at ${ stage } after ${ attempts } attempt(s) (budget ${ timeoutMs } ms).`);
    this.name = 'LoopProviderResolutionError';
  }
}

class LoopProviderStageTimeoutError extends Error {
  constructor(readonly stage: string) {
    super();
    this.name = 'LoopProviderStageTimeoutError';
  }
}

const DEFAULT_OPTIONS: Required<LoopProviderResolutionOptions> = {
  timeoutMs: 30_000,
  attemptTimeoutMs: 9_000,
  maxAttempts: 3,
  retryBackoffMs: [250, 500],
};

/** Applies one shared deadline and bounded retries to provider selection and persistence stages. */
export class LoopProviderResolution {
  private readonly options: Required<LoopProviderResolutionOptions>;

  constructor(
    options: LoopProviderResolutionOptions = {},
    private readonly monotonicNow: () => number = () => performance.now(),
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options, retryBackoffMs: [...(options.retryBackoffMs ?? DEFAULT_OPTIONS.retryBackoffMs)] };
  }

  async run<T>(
    resolve: (attempt: LoopProviderResolutionAttempt) => Promise<T>,
    externalSignal?: AbortSignal,
  ): Promise<T> {
    if (externalSignal?.aborted) throw externalSignal.reason ?? new DOMException('Aborted', 'AbortError');

    const deadline = this.monotonicNow() + this.options.timeoutMs;
    let activeStage = 'provider selection';
    let currentAttempt = 0;
    let activeController: AbortController | undefined;
    let expired = false;
    let rejectAbort: ((reason: unknown) => void) | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    const deadlineFailure = new Promise<never>((_resolve, reject) => {
      const enforceDeadline = () => {
        const remaining = deadline - this.monotonicNow();
        if (remaining > 0) {
          timeoutTimer = setTimeout(enforceDeadline, remaining);
          return;
        }
        expired = true;
        activeController?.abort();
        reject(new LoopProviderResolutionError(activeStage, Math.max(currentAttempt, 1), this.options.timeoutMs, true));
      };
      timeoutTimer = setTimeout(enforceDeadline, this.options.timeoutMs);
    });
    const abortFailure = new Promise<never>((_resolve, reject) => { rejectAbort = reject });
    const abort = () => {
      activeController?.abort(externalSignal?.reason);
      rejectAbort?.(externalSignal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    externalSignal?.addEventListener('abort', abort, { once: true });

    const attempts = this.runAttempts(resolve, deadline, externalSignal, (controller, attempt, stage) => {
      activeController = controller;
      currentAttempt = attempt;
      activeStage = stage;
    }, () => expired);

    try {
      return await Promise.race([attempts, deadlineFailure, abortFailure]);
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      externalSignal?.removeEventListener('abort', abort);
      activeController?.abort();
    }
  }

  private async runAttempts<T>(
    resolve: (attempt: LoopProviderResolutionAttempt) => Promise<T>,
    deadline: number,
    externalSignal: AbortSignal | undefined,
    setActive: (controller: AbortController, attempt: number, stage: string) => void,
    isExpired: () => boolean,
  ): Promise<T> {
    let lastStage = 'provider selection';
    let lastTimedOut = false;
    let attemptsUsed = 0;

    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt++) {
      if (isExpired()) break;
      if (externalSignal?.aborted) throw externalSignal.reason ?? new DOMException('Aborted', 'AbortError');

      attemptsUsed = attempt;
      const attemptStarted = this.monotonicNow();
      const attemptDeadline = Math.min(deadline, attemptStarted + this.options.attemptTimeoutMs);
      const controller = new AbortController();
      const forwardAbort = () => controller.abort(externalSignal?.reason);
      externalSignal?.addEventListener('abort', forwardAbort, { once: true });
      let currentStage = 'provider selection';
      setActive(controller, attempt, currentStage);

      try {
        return await this.withTimeout(
          () => resolve({
            signal: controller.signal,
            stage: <T>(name: string, work: () => Promise<T>) => {
              currentStage = name;
              lastStage = name;
              setActive(controller, attempt, name);
              return this.withTimeout(work, name, Math.min(deadline, attemptDeadline) - this.monotonicNow());
            },
          }),
          () => currentStage,
          attemptDeadline - this.monotonicNow(),
        );
      } catch (error) {
        if (isExpired() || externalSignal?.aborted) throw error;
        lastStage = error instanceof LoopProviderStageTimeoutError ? error.stage : currentStage;
        lastTimedOut = error instanceof LoopProviderStageTimeoutError;
        controller.abort();

        const remaining = deadline - this.monotonicNow();
        if (attempt >= this.options.maxAttempts || remaining <= 0) break;
        const backoffMs = Math.min(this.options.retryBackoffMs[attempt - 1] ?? 0, remaining);
        console.warn(`[LoopProviderResolution] retry stage=${ lastStage } attempt=${ attempt }/${ this.options.maxAttempts } elapsedMs=${ Math.round(this.monotonicNow() - attemptStarted) }`);
        if (backoffMs > 0) await new Promise<void>(resolveDelay => setTimeout(resolveDelay, backoffMs));
      } finally {
        externalSignal?.removeEventListener('abort', forwardAbort);
      }
    }

    throw new LoopProviderResolutionError(lastStage, attemptsUsed, this.options.timeoutMs, lastTimedOut);
  }

  private async withTimeout<T>(work: () => Promise<T>, stage: string | (() => string), timeoutMs: number): Promise<T> {
    const stageName = typeof stage === 'function' ? stage() : stage;
    if (timeoutMs <= 0) throw new LoopProviderStageTimeoutError(stageName);
    const deadline = this.monotonicNow() + timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(work),
        new Promise<never>((_resolve, reject) => {
          const enforceDeadline = () => {
            const remaining = deadline - this.monotonicNow();
            if (remaining > 0) {
              timer = setTimeout(enforceDeadline, remaining);
              return;
            }
            reject(new LoopProviderStageTimeoutError(typeof stage === 'function' ? stage() : stage));
          };
          timer = setTimeout(enforceDeadline, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
