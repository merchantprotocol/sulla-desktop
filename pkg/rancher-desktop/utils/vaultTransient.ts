/** Connection errors that mean "the vault container is still (re)starting", not "the vault is broken". */
const TRANSIENT = /ERR_CONNECTION_(REFUSED|CLOSED|RESET|TIMED_OUT)|ECONN(REFUSED|RESET)|ETIMEDOUT|EPIPE|socket hang up|Vault service is unavailable/i;

export function isTransientVaultError(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause ?? '');

  return TRANSIENT.test(message);
}

/** Retry `work` while it fails with a transient vault connection error. */
export async function retryTransientVault<T>(
  work: () => Promise<T>,
  { attempts = 8, delayMs = 1_500, shouldContinue = () => true }: { attempts?: number; delayMs?: number; shouldContinue?: () => boolean } = {},
): Promise<T> {
  let last: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await work();
    } catch (error) {
      last = error;
      if (!isTransientVaultError(error) || attempt === attempts || !shouldContinue()) throw error;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  throw last;
}
