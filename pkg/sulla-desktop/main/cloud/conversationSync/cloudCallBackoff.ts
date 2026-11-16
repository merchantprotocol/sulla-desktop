// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * A Sulla Cloud call failed before Cloud answered: the vault broker timed out,
 * returned an error, was locked, or the network was down. Nothing about the
 * failure is specific to one conversation, so callers stop the pass instead of
 * repeating the same call for every linked chat.
 */
export class CloudTransportError extends Error {
  readonly code: string;
  readonly original: unknown;

  constructor(original: unknown) {
    super(original instanceof Error ? original.message : String(original));
    this.name = 'CloudTransportError';
    this.original = original;
    this.code = CloudTransportError.codeOf(original);
  }

  /** A short, non-secret code: the vault broker error code, else the error name. */
  static codeOf(error: unknown): string {
    const candidate = error as { code?: unknown; name?: unknown } | null;
    if (candidate && typeof candidate.code === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(candidate.code)) return candidate.code;
    if (candidate && typeof candidate.name === 'string' && candidate.name && candidate.name !== 'Error') return candidate.name;
    return 'transport_error';
  }
}

export interface CloudCallBackoffLogger {
  warn(...args: unknown[]): void;
  log(...args: unknown[]): void;
}

export interface CloudCallBackoffClock { now(): number }

/**
 * Bounded exponential backoff for one kind of Sulla Cloud call, with one log
 * line per failure streak (and per change of error code) instead of one stack
 * trace per attempt. Contains timestamps and counts only.
 */
export class CloudCallBackoff {
  private failures = 0;
  private blockedUntil = 0;
  private lastCode: string | null = null;
  private suppressed = 0;
  private readonly label: string;
  private readonly logger: CloudCallBackoffLogger;
  private readonly clock: CloudCallBackoffClock;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;

  // Plain fields (no parameter properties) so the focused spec runs under Node's strip-types runner.
  constructor(
    label: string,
    logger: CloudCallBackoffLogger,
    clock: CloudCallBackoffClock = { now: () => Date.now() },
    baseDelayMs = 30_000,
    maxDelayMs = 15 * 60_000,
  ) {
    this.label = label;
    this.logger = logger;
    this.clock = clock;
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
  }

  /** False while a previous failure's backoff window is still open. */
  canAttempt(): boolean {
    return this.clock.now() >= this.blockedUntil;
  }

  get consecutiveFailures(): number {
    return this.failures;
  }

  /** Records a failure and returns how long callers should wait before trying again. */
  failed(code: string): number {
    this.failures += 1;
    const delay = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** Math.min(this.failures - 1, 30));
    this.blockedUntil = this.clock.now() + delay;
    if (this.failures === 1 || code !== this.lastCode) {
      const repeats = this.suppressed ? `; ${ this.suppressed } identical failure(s) since the last report` : '';
      this.logger.warn(`[ConversationSync] ${ this.label } unavailable (${ code }); attempt ${ this.failures }, retrying in ${ Math.round(delay / 1000) }s${ repeats }`);
      this.suppressed = 0;
    } else {
      this.suppressed += 1;
    }
    this.lastCode = code;
    return delay;
  }

  /** Clears the streak; logs one recovery line when there was one. */
  succeeded(): void {
    if (this.failures > 0) {
      this.logger.log(`[ConversationSync] ${ this.label } recovered after ${ this.failures } failed attempt(s)`);
    }
    this.failures = 0;
    this.blockedUntil = 0;
    this.lastCode = null;
    this.suppressed = 0;
  }
}
