import { postgresClient } from '../../database/PostgresClient';

import type { ProjectsDomainEventRecord } from '../application/ProjectsRepositories';

export class ProjectsDomainEventOutbox {
  static async claim(owner: string, limit = 25, leaseSeconds = 120): Promise<ProjectsDomainEventRecord[]> {
    const normalizedOwner = owner.trim();
    if (!normalizedOwner) throw new Error('Projects outbox lease owner is required.');
    const boundedLimit = Math.max(1, Math.min(100, limit));
    const boundedLease = Math.max(15, Math.min(900, leaseSeconds));
    return postgresClient.transaction(async(client) => {
      const claimed = await client.query<ProjectsDomainEventRecord>(`
        WITH candidates AS (
          SELECT id
            FROM work_project_domain_events
           WHERE (status = 'pending' AND available_at <= now())
              OR (status = 'processing' AND leased_until <= now())
           ORDER BY available_at ASC, created_at ASC
           FOR UPDATE SKIP LOCKED
           LIMIT $1
        )
        UPDATE work_project_domain_events event
           SET status = 'processing', attempts = attempts + 1,
               lease_owner = $2, leased_until = now() + ($3 * interval '1 second'),
               updated_at = now(), last_error = NULL
          FROM candidates
         WHERE event.id = candidates.id
        RETURNING event.*
      `, [boundedLimit, normalizedOwner, boundedLease]);
      return claimed.rows;
    });
  }

  static async complete(id: string, owner: string): Promise<boolean> {
    const rows = await postgresClient.query<{ id: string }>(`
      UPDATE work_project_domain_events
         SET status = 'completed', lease_owner = NULL, leased_until = NULL,
             completed_at = now(), updated_at = now(), last_error = NULL
       WHERE id = $1 AND status = 'processing' AND lease_owner = $2
      RETURNING id
    `, [id, owner]);
    return rows.length === 1;
  }

  static async retry(id: string, owner: string, error: string, availableAt: Date): Promise<boolean> {
    const rows = await postgresClient.query<{ id: string }>(`
      UPDATE work_project_domain_events
         SET status = 'pending', lease_owner = NULL, leased_until = NULL,
             available_at = $3, updated_at = now(), last_error = $4
       WHERE id = $1 AND status = 'processing' AND lease_owner = $2
      RETURNING id
    `, [id, owner, availableAt.toISOString(), error.slice(0, 2_000)]);
    return rows.length === 1;
  }
}
