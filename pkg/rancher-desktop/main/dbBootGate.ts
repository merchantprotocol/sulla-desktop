/**
 * Single-flight boot gate for main-process work that needs PostgreSQL.
 *
 * Postgres runs inside the Lima VM and can take a minute+ to come up on a
 * cold boot. Boot-time recovery that fires before it is reachable dies with
 * ECONNREFUSED 127.0.0.1:30116 and, without a retry, stays dead until the
 * next app restart — leaving the whole conveyor idle with the dispatcher
 * reporting no-eligible-work (observed 2026-08-31 boot).
 *
 * The retry is intentionally unbounded, for the same reason as
 * PostgresClient.waitForReady: a finite boot budget turns a slow cold start
 * into a session-long outage for every DB-dependent recovery path.
 */

type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** How many retry intervals between repeated not-ready log lines. */
const LOG_EVERY_N_ATTEMPTS = 12;

export function createDbBootGate(
  initialize: () => Promise<unknown>,
  retryMs = 5_000,
  sleep: Sleep = defaultSleep,
): () => Promise<void> {
  let gate: Promise<void> | null = null;

  return function awaitDatabaseReady(): Promise<void> {
    gate ??= (async() => {
      for (let attempt = 1; ; attempt++) {
        try {
          await initialize();
          if (attempt > 1) {
            console.log(`[DbBootGate] Database ready after ${ attempt } attempts`);
          }

          return;
        } catch (error) {
          if (attempt === 1 || attempt % LOG_EVERY_N_ATTEMPTS === 0) {
            console.warn(`[DbBootGate] Database not ready (attempt ${ attempt }); retrying every ${ retryMs }ms:`, error);
          }
          await sleep(retryMs);
        }
      }
    })();

    return gate;
  };
}

/**
 * Shared process-wide gate. Resolves once DatabaseManager has initialized;
 * never rejects — callers queued behind it simply wait until the DB is up.
 */
export const awaitDatabaseReady = createDbBootGate(async() => {
  const { getDatabaseManager } = await import('@pkg/agent/database/DatabaseManager');

  await getDatabaseManager().initialize();
});
