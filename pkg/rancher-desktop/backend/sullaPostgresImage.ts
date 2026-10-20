/**
 * Chooses the image for the `postgres` compose service, Desktop's only
 * database. The pgvector image (services/sulla-postgres) is preferred, but
 * Postgres is the first service started, so a missing image must never leave
 * the app without a database: when the preferred image is neither present in
 * the VM nor pullable (offline, registry down), Desktop starts the previous
 * stock `postgres:16-alpine` image instead. Both are Alpine (musl) PostgreSQL
 * 16 and mount the same data volume unchanged; on the stock image Files reports
 * `vectorSearch: 'unavailable'` and searches by full text only.
 *
 * A present image is used as-is (no refresh pull), so Postgres is recreated
 * only when the image actually changes: once, on the switch.
 */
export const SULLA_POSTGRES_FALLBACK_IMAGE = 'postgres:16-alpine';

/** Upper bound for the startup pull; a hung registry must not stall boot. */
export const SULLA_POSTGRES_PULL_TIMEOUT_SECONDS = 300;

export type SullaPostgresImageSource = 'local' | 'pulled' | 'fallback';

export interface SullaPostgresImageSelection {
  image:  string;
  /** pgvector expected; false means the fallback image (Files degrades to full-text search). */
  vector: boolean;
  source: SullaPostgresImageSource;
}

export interface SelectSullaPostgresImageOptions {
  preferred: string;
  fallback?: string;
  /** Runs a command as root in the VM; rejects on a non-zero exit. */
  run:       (...command: string[]) => Promise<unknown>;
  log?:      Pick<Console, 'log'>;
}

export async function selectSullaPostgresImage(options: SelectSullaPostgresImageOptions): Promise<SullaPostgresImageSelection> {
  const { preferred, fallback = SULLA_POSTGRES_FALLBACK_IMAGE, run, log = console } = options;

  if (preferred === fallback) return { image: fallback, vector: false, source: 'local' };
  try {
    await run('docker', 'image', 'inspect', '--format', '{{.Id}}', preferred);

    return { image: preferred, vector: true, source: 'local' };
  } catch {
    // Not present yet (first launch after the update): pull it below.
  }
  try {
    await run('timeout', String(SULLA_POSTGRES_PULL_TIMEOUT_SECONDS), 'docker', 'pull', preferred);

    return { image: preferred, vector: true, source: 'pulled' };
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).split('\n')[0];

    log.log(`[Sulla] Postgres image ${ preferred } unavailable (${ reason }); starting ${ fallback } instead, vector search disabled until it can be pulled`);

    return { image: fallback, vector: false, source: 'fallback' };
  }
}
