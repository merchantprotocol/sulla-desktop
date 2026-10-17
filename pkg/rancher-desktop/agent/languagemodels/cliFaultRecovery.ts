export const CLI_RECOVERY_MAX_ATTEMPTS = 2;
export const CLI_RECOVERY_BACKOFF_MS = 750;

export type CliFaultKind = 'spawn' | 'transport' | 'process_exit' | 'stall' | 'protocol';

export class CliFaultError extends Error {
  readonly cliFault = true;

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

export class CliRecoveryExhaustedError extends Error {
  readonly cliRecoveryExhausted = true;

  constructor(readonly faultKind: CliFaultKind, message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'CliRecoveryExhaustedError';
  }
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

export function isPermanentCliFailure(message: string): boolean {
  return /unauthorized|invalid api key|credential|quota|usage balance|weekly limit|session limit|rate limit|too many requests/i.test(message);
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
      if (!isCliFault(error)) throw error;
      lastFault = error;
      if (attempt >= maxAttempts) break;
      if (!error.retrySafe || !options.canRetry()) break;
      options.onRetry?.(error, attempt + 1);
      await abortableDelay(options.backoffMs ?? CLI_RECOVERY_BACKOFF_MS, options.signal);
    }
  }

  const fault = lastFault ?? new CliFaultError('protocol', 'unknown CLI failure');
  throw new CliRecoveryExhaustedError(fault.kind, `${ providerName } recovery exhausted: ${ fault.message }`, fault);
}

function abortError(): Error {
  const error = new Error('CLI run aborted');
  error.name = 'AbortError';
  return error;
}
