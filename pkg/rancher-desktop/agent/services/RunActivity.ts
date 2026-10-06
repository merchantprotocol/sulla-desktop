/**
 * Last-activity clock for whole runs (a dispatch, a spawned job) including
 * every sub-agent they start. A graph state carries `metadata.activityKeys`;
 * each LLM token, thinking event and tool call touches every key, and child
 * states inherit their parent's keys. Dead-run detection reads this instead
 * of a lease timer, which keeps renewing whether or not the agent does work.
 */
const lastActivity = new Map<string, number>();

export const RunActivity = {
  begin(key: string): void {
    lastActivity.set(key, Date.now());
  },

  touch(metadata: any): void {
    const keys = metadata?.activityKeys;
    if (!Array.isArray(keys) || keys.length === 0) return;
    const now = Date.now();
    for (const key of keys) {
      if (typeof key === 'string') lastActivity.set(key, now);
    }
  },

  /** Keys a child graph should carry: its parent's plus any of its own. */
  inherit(parentMetadata: any, ...own: string[]): string[] {
    const inherited = Array.isArray(parentMetadata?.activityKeys) ? parentMetadata.activityKeys : [];
    return [...new Set([...inherited, ...own].filter((key): key is string => typeof key === 'string' && key.length > 0))];
  },

  lastActivityAt(key: string): number | undefined {
    return lastActivity.get(key);
  },

  end(key: string): void {
    lastActivity.delete(key);
  },
};

export const DEAD_RUN_CHECK_MS = 60_000;
/** After a dead run is aborted, how long to wait for it to return before letting go. */
export const DEAD_RUN_GRACE_MS = 180_000;
const DEFAULT_DEAD_RUN_MINUTES = 30;

/** Minutes of tree-wide silence before a run counts as dead (setting taskDispatcherDeadRunMinutes). */
export async function deadRunMinutes(): Promise<number> {
  const { SullaSettingsModel } = await import('../database/models/SullaSettingsModel');
  const value = Number(await SullaSettingsModel.get('taskDispatcherDeadRunMinutes', DEFAULT_DEAD_RUN_MINUTES));
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_DEAD_RUN_MINUTES;
}

/**
 * Watch a run's activity clock and call `onDead` once it has been silent past
 * the dead-run threshold. Returns a stop function that also clears the clock.
 */
export function watchForDeadRun(
  key: string,
  onDead: (reason: string) => void | Promise<void>,
  stillAlive: () => Promise<boolean> = async() => false,
): () => void {
  RunActivity.begin(key);
  let fired = false;
  const timer = setInterval(() => {
    void (async() => {
      if (fired) return;
      const minutes = await deadRunMinutes();
      const last = RunActivity.lastActivityAt(key) ?? Date.now();
      if (Date.now() - last < minutes * 60_000) return;
      if (await stillAlive()) return;
      fired = true;
      await onDead(`no agent activity for ${ minutes } minute(s)`);
    })().catch(err => console.warn(`[RunActivity] dead-run check failed for ${ key }:`, err));
  }, DEAD_RUN_CHECK_MS);
  return () => {
    clearInterval(timer);
    RunActivity.end(key);
  };
}
