import { createPostgresProjectsRepositories } from './PostgresProjectsRepositories';
import { postgresClient } from '../../database/PostgresClient';

import type { ProjectsRepositories } from '../application/ProjectsRepositories';
import type { ProjectsUnitOfWork } from '../application/ProjectsUnitOfWork';
import type { PoolClient } from 'pg';

type ClientFactory = () => Promise<PoolClient>;

/** PostgreSQL transaction adapter. It never nests or commits a caller-owned client. */
export class PostgresProjectsUnitOfWork implements ProjectsUnitOfWork {
  constructor(private readonly getClient: ClientFactory = () => postgresClient.getClient()) {}

  async execute<T>(work: (repositories: ProjectsRepositories) => Promise<T>): Promise<T> {
    const client = await this.getClient();
    try {
      await client.query('BEGIN');
      const result = await work(createPostgresProjectsRepositories(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Compose repositories into a transaction already owned by an outer service. */
  static useExisting<T>(client: PoolClient, work: (repositories: ProjectsRepositories) => Promise<T>): Promise<T> {
    return work(createPostgresProjectsRepositories(client));
  }
}
