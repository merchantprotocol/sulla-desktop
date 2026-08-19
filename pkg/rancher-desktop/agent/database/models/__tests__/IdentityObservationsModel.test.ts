import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { postgresClient } from '../../PostgresClient';
import { formatIdentityObservationDate, IdentityObservationsModel, normalizeIdentityDomain } from '../IdentityObservationsModel';

describe('IdentityObservationsModel', () => {
  let originalQuery: any;
  let originalQueryWithResult: any;

  beforeAll(() => {
    originalQuery = postgresClient.query;
    originalQueryWithResult = postgresClient.queryWithResult;
  });

  afterEach(() => {
    (postgresClient as any).query = originalQuery;
    (postgresClient as any).queryWithResult = originalQueryWithResult;
    jest.restoreAllMocks();
  });

  it('inserts domain-scoped observations with normalized fields', async() => {
    const inserted = {
      id:         'hum1',
      domain:     'human',
      level:      2,
      category:   'preference',
      content:    'Jonathon prefers direct status reports.',
      basis:      'Repeated instruction in chat.',
      created_at: '2026-08-19T18:00:00.000Z',
      updated_at: null,
      archived:   false,
      source:     'test',
    };
    (postgresClient as any).query = jest.fn(() => Promise.resolve([inserted]));

    const row = await IdentityObservationsModel.insert({
      id:       'hum1',
      domain:   ' Human ',
      level:    2,
      category: ' preference ',
      content:  ' Jonathon prefers direct status reports. ',
      basis:    ' Repeated instruction in chat. ',
      source:   ' test ',
    });

    expect(postgresClient.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO identity_observations'),
      ['hum1', 'human', 2, 'preference', 'Jonathon prefers direct status reports.', 'Repeated instruction in chat.', 'test'],
    );
    expect(row).toBe(inserted);
  });

  it('rejects invalid domains and certainty levels instead of coercing them', async() => {
    (postgresClient as any).query = jest.fn(() => Promise.resolve([]));

    await expect(IdentityObservationsModel.insert({
      id:      'bad1',
      domain:  'bogus',
      level:   3,
      content: 'Should fail.',
    })).rejects.toThrow('Invalid identity domain');

    await expect(IdentityObservationsModel.insert({
      id:      'bad2',
      domain:  'human',
      level:   9,
      content: 'Should fail.',
    })).rejects.toThrow('Invalid identity certainty level');

    expect(postgresClient.query).not.toHaveBeenCalled();
  });

  it('rejects empty or overlong content before writing', async() => {
    (postgresClient as any).query = jest.fn(() => Promise.resolve([]));

    await expect(IdentityObservationsModel.insert({
      id:      'bad3',
      domain:  'human',
      level:   3,
      content: '   ',
    })).rejects.toThrow('content is required');

    await expect(IdentityObservationsModel.insert({
      id:      'bad4',
      domain:  'human',
      level:   3,
      content: 'x'.repeat(1201),
    })).rejects.toThrow('content must be 1200 characters or fewer');

    expect(postgresClient.query).not.toHaveBeenCalled();
  });

  it('normalizes supported identity domains and rejects unsupported domains', () => {
    expect(normalizeIdentityDomain(undefined)).toBe('human');
    expect(normalizeIdentityDomain(' Business ')).toBe('business');
    expect(() => normalizeIdentityDomain('not-a-domain')).toThrow('Invalid identity domain');
  });

  it('formats Date and string timestamps consistently for tool output', () => {
    expect(formatIdentityObservationDate(new Date('2026-08-19T18:00:00.000Z'))).toBe('2026-08-19');
    expect(formatIdentityObservationDate('2026-08-19T18:00:00.000Z')).toBe('2026-08-19');
    expect(formatIdentityObservationDate(null)).toBe('');
  });

  it('updates only provided mutable fields and stamps updated_at', async() => {
    (postgresClient as any).query = jest.fn(() => Promise.resolve([{ id: 'hum1', level: 3 }]));

    await IdentityObservationsModel.update('hum1', {
      level:   3,
      content: 'Jonathon stated this directly.',
    });

    expect(postgresClient.query).toHaveBeenCalledWith(
      expect.stringContaining('updated_at = now(), level = $1, content = $2'),
      [3, 'Jonathon stated this directly.', 'hum1'],
    );
    expect((postgresClient.query as any).mock.calls[0][0]).toContain('WHERE id = $3 RETURNING *');
  });

  it('lists active rows by domain, certainty, and recency', async() => {
    (postgresClient as any).query = jest.fn(() => Promise.resolve([]));

    await IdentityObservationsModel.listActive('human', {
      level:    3,
      category: 'identity',
      limit:    12,
    });

    const [sql, params] = (postgresClient.query as any).mock.calls[0];
    expect(sql).toContain('archived = false AND domain = $1');
    expect(sql).toContain('level = $2');
    expect(sql).toContain('category = $3');
    expect(sql).toContain('ORDER BY level DESC, created_at DESC');
    expect(sql).toContain('LIMIT $4');
    expect(params).toEqual(['human', 3, 'identity', 12]);
  });

  it('bounds list limits to protect prompt context size', async() => {
    (postgresClient as any).query = jest.fn(() => Promise.resolve([]));

    await IdentityObservationsModel.listActive('human', { limit: 10000 });

    const [, params] = (postgresClient.query as any).mock.calls[0];
    expect(params).toEqual(['human', 100]);
  });

  it('searches by phrase and meaningful words within one domain', async() => {
    (postgresClient as any).query = jest.fn(() => Promise.resolve([]));

    await IdentityObservationsModel.search('human', 'direct status reports', 5000, false);

    const [sql, params] = (postgresClient.query as any).mock.calls[0];
    expect(sql).toContain('archived = false');
    expect(sql).toContain('domain = $1');
    expect(sql).toContain('content ILIKE $2');
    expect(sql).toContain('ORDER BY (content ILIKE $2)::int DESC');
    expect(params).toEqual([
      'human',
      '%direct status reports%',
      100,
      '%direct%',
      '%status%',
      '%reports%',
    ]);
  });

  it('soft-archives observations instead of deleting them', async() => {
    (postgresClient as any).queryWithResult = jest.fn(() => Promise.resolve({ rowCount: 1 }));

    await expect(IdentityObservationsModel.archive('hum1')).resolves.toBe(true);

    expect(postgresClient.queryWithResult).toHaveBeenCalledWith(
      expect.stringContaining('SET archived = true, updated_at = now()'),
      ['hum1'],
    );
  });

  it('finds duplicates only within the requested domain', async() => {
    jest.spyOn(IdentityObservationsModel, 'listActive').mockResolvedValue([
      {
        id:         'hum1',
        domain:     'human',
        level:      3,
        category:   'preference',
        content:    'Jonathon prefers direct status reports.',
        basis:      null,
        created_at: '2026-08-19T18:00:00.000Z',
        updated_at: null,
        archived:   false,
        source:     null,
      },
    ]);

    const duplicate = await IdentityObservationsModel.findDuplicate('human', 'Jonathon prefers direct status reports');

    expect(IdentityObservationsModel.listActive).toHaveBeenCalledWith('human', { limit: 500 });
    expect(duplicate?.id).toBe('hum1');
  });
});
