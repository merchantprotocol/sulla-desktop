import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { postgresClient } from '../../../database/PostgresClient';
import { PostgresProjectsSchemaVerifier } from '../PostgresProjectsSchemaVerifier';

describe('PostgresProjectsSchemaVerifier', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('verifies migrated relations without issuing DDL', async() => {
    const query = jest.spyOn(postgresClient, 'query').mockResolvedValue([
      { relation_name: 'work_projects', relation: 'work_projects' },
    ]);

    await expect(PostgresProjectsSchemaVerifier.verify(['work_projects'])).resolves.toBeUndefined();
    expect(query.mock.calls[0][0]).toContain('to_regclass');
    expect(query.mock.calls[0][0]).not.toMatch(/CREATE|ALTER|DROP/i);
  });

  it('fails closed when an ordered migration has not installed a relation', async() => {
    jest.spyOn(postgresClient, 'query').mockResolvedValue([
      { relation_name: 'work_tasks', relation: null },
    ]);

    await expect(PostgresProjectsSchemaVerifier.verify(['work_tasks']))
      .rejects.toThrow('missing relations: work_tasks');
  });
});
