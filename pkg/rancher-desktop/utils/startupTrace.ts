/**
 * Phase tracing for startup stalls. `traceAsync` logs begin/end with duration
 * and registers the phase with a watchdog that names every phase still
 * pending every 10 s, so a hang shows exactly where it is stuck.
 */
const WATCHDOG_INTERVAL_MS = 10_000;
const pending = new Map<number, { label: string; since: number }>();
let nextId = 0;
let watchdog: ReturnType<typeof setInterval> | undefined;

function ensureWatchdog(): void {
  if (watchdog) return;
  watchdog = setInterval(() => {
    const now = Date.now();

    for (const { label, since } of pending.values()) {
      if (now - since >= WATCHDOG_INTERVAL_MS) console.warn(`[FilesTrace] STUCK in "${ label }" for ${ Math.round((now - since) / 1000) }s`);
    }
    if (!pending.size && watchdog) {
      clearInterval(watchdog);
      watchdog = undefined;
    }
  }, WATCHDOG_INTERVAL_MS);
  watchdog.unref?.();
}

export function traceEvent(message: string): void {
  console.log(`[FilesTrace] ${ message }`);
}

export async function traceAsync<T>(label: string, work: () => Promise<T>): Promise<T> {
  const id = nextId++;
  const since = Date.now();

  pending.set(id, { label, since });
  ensureWatchdog();
  console.log(`[FilesTrace] begin ${ label }`);
  try {
    const value = await work();

    console.log(`[FilesTrace] end ${ label } (${ Date.now() - since } ms)`);

    return value;
  } catch (error) {
    console.warn(`[FilesTrace] FAILED ${ label } after ${ Date.now() - since } ms: ${ error instanceof Error ? error.message : String(error) }`);
    throw error;
  } finally {
    pending.delete(id);
  }
}
