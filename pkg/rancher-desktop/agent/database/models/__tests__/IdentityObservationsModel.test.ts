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
      ['hum1', 'human', 2, 'preference', 'Jonathon prefers direct status reports.', 'Repeated instruction in chat.', null, null, null, null, 'test'],
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
    expect(normalizeIdentityDomain(' Environment ')).toBe('environment');
    expect(() => normalizeIdentityDomain('not-a-domain')).toThrow('Invalid identity domain');
  });

  it('formats Date and string timestamps consistently for tool output', () => {
    expect(formatIdentityObservationDate(new Date('2026-08-19T18:00:00.000Z'))).toBe('2026-08-19');
    expect(formatIdentityObservationDate('2026-08-19T18:00:00.000Z')).toBe('2026-08-19');
    expect(formatIdentityObservationDate(null)).toBe('');
  });

  it('updates only provided mutable fields and stamps updated_at', async() => {
    // update() fetches the existing row first (getById) to know the row's
    // domain for write-guard validation, then issues the UPDATE — two calls.
    (postgresClient as any).query = (jest.fn() as any)
      .mockResolvedValueOnce([{ id: 'hum1', domain: 'human', level: 2 }])
      .mockResolvedValueOnce([{ id: 'hum1', level: 3 }]);

    await IdentityObservationsModel.update('hum1', {
      level:   3,
      content: 'Jonathon stated this directly.',
    });

    expect(postgresClient.query).toHaveBeenCalledWith(
      expect.stringContaining('updated_at = now(), level = $1, content = $2'),
      [3, 'Jonathon stated this directly.', 'hum1'],
    );
    expect((postgresClient.query as any).mock.calls[1][0]).toContain('WHERE id = $3 RETURNING *');
  });

  it('returns null when updating an observation that no longer exists', async() => {
    (postgresClient as any).query = (jest.fn() as any).mockResolvedValueOnce([]);

    const result = await IdentityObservationsModel.update('gone', { level: 3 });

    expect(result).toBeNull();
    expect(postgresClient.query).toHaveBeenCalledTimes(1);
  });

  it('rejects a category outside the domain\'s closed set', async() => {
    (postgresClient as any).query = jest.fn(() => Promise.resolve([]));

    await expect(IdentityObservationsModel.insert({
      id:       'bad5',
      domain:   'human',
      level:    2,
      category: 'not-a-real-category',
      content:  'Some fact about the human.',
    })).rejects.toThrow('is not valid for domain "human"');

    expect(postgresClient.query).not.toHaveBeenCalled();
  });

  it('rejects subject outside the agent domain (the business-domain misfile pattern)', async() => {
    (postgresClient as any).query = jest.fn(() => Promise.resolve([]));

    await expect(IdentityObservationsModel.insert({
      id:      'bad6',
      domain:  'business',
      level:   2,
      subject: 'agent.user',
      content: 'The business ships receptionist software.',
    })).rejects.toThrow('subject is only valid in the agent domain');

    expect(postgresClient.query).not.toHaveBeenCalled();
  });

  it('rejects kind outside the agent domain (same gap as subject, same fix)', async() => {
    (postgresClient as any).query = jest.fn(() => Promise.resolve([]));

    await expect(IdentityObservationsModel.insert({
      id:      'bad9',
      domain:  'environment',
      level:   2,
      kind:    'method',
      content: 'The build cannot run in the Lima VM.',
    })).rejects.toThrow('kind is only valid in the agent domain');

    expect(postgresClient.query).not.toHaveBeenCalled();
  });

  it('accepts kind within the agent domain', async() => {
    const inserted = { id: 'ag01', domain: 'agent', level: 3, kind: 'method', content: 'Agent drafts PRs; the human merges.' };
    (postgresClient as any).query = jest.fn(() => Promise.resolve([inserted]));

    const row = await IdentityObservationsModel.insert({
      id:      'ag01',
      domain:  'agent',
      level:   3,
      kind:    'method',
      subject: 'agent.user',
      content: 'Agent drafts PRs; the human merges.',
    });

    expect(row).toBe(inserted);
  });

  it('rejects content that reads as task/PR/commit status', async() => {
    (postgresClient as any).query = jest.fn(() => Promise.resolve([]));

    await expect(IdentityObservationsModel.insert({
      id:      'bad7',
      domain:  'human',
      level:   2,
      content: 'Opened draft PR #633 for the skills domain.',
    })).rejects.toThrow('task/engineering status');

    expect(postgresClient.query).not.toHaveBeenCalled();
  });

  it('rejects skills-domain content with no quoted skill slug', async() => {
    (postgresClient as any).query = jest.fn(() => Promise.resolve([]));

    await expect(IdentityObservationsModel.insert({
      id:      'bad8',
      domain:  'skills',
      level:   2,
      content: 'A skill ran successfully today.',
    })).rejects.toThrow('must name the exact skill');

    expect(postgresClient.query).not.toHaveBeenCalled();
  });

  it('accepts well-formed skills-domain content naming a slug', async() => {
    const inserted = { id: 'sk01', domain: 'skills', level: 3, category: 'success', content: "Skill 'pdf-fill' succeeded filling a 12-field form." };
    (postgresClient as any).query = jest.fn(() => Promise.resolve([inserted]));

    const row = await IdentityObservationsModel.insert({
      id:       'sk01',
      domain:   'skills',
      level:    3,
      category: 'success',
      content:  "Skill 'pdf-fill' succeeded filling a 12-field form.",
    });

    expect(row).toBe(inserted);
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

  it('finds duplicates by scanning up to 500 rows directly, bypassing the public 100-row list cap', async() => {
    (postgresClient as any).query = jest.fn(() => Promise.resolve([
      {
        id:         'hum1',
        domain:     'human',
        level:      3,
        category:   'preference',
        content:    'Jonathon prefers direct status reports.',
        basis:      null,
        subject:    null,
        evidence:   null,
        confidence: null,
        kind:       null,
        created_at: '2026-08-19T18:00:00.000Z',
        updated_at: null,
        archived:   false,
        source:     null,
      },
    ]));

    const duplicate = await IdentityObservationsModel.findDuplicate('human', 'Jonathon prefers direct status reports');

    const [sql, params] = (postgresClient.query as any).mock.calls[0];
    expect(sql).toContain('WHERE archived = false AND domain = $1');
    expect(params).toEqual(['human', 500]);
    expect(duplicate?.id).toBe('hum1');
  });

  it('counts active rows for the recall row-count gate', async() => {
    (postgresClient as any).query = jest.fn(() => Promise.resolve([{ count: '7' }]));

    const count = await IdentityObservationsModel.countActive('agent');

    expect(postgresClient.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE archived = false AND domain = $1'),
      ['agent'],
    );
    expect(count).toBe(7);
  });
});
