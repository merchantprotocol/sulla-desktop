import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { IdentityObservationsModel } from '../../../database/models/IdentityObservationsModel';
import { AddIdentityObservationWorker } from '../add_identity_observation';
import { ListIdentityObservationsWorker } from '../list_identity_observations';
import { RemoveIdentityObservationWorker } from '../remove_identity_observation';
import { SearchIdentityObservationsWorker } from '../search_identity_observations';

function withSchema<T extends { name: string; description: string; schemaDef: Record<string, any> }>(
  worker: T,
  name: string,
  schemaDef: Record<string, any>,
): T {
  worker.name = name;
  worker.description = name;
  worker.schemaDef = schemaDef;
  return worker;
}

function addWorker() {
  return withSchema(new AddIdentityObservationWorker(), 'add_identity_observation', {
    id:       { type: 'string', optional: true },
    domain:   { type: 'string', optional: true },
    level:    { type: 'number' },
    category: { type: 'string', optional: true },
    content:  { type: 'string' },
    basis:    { type: 'string', optional: true },
    source:   { type: 'string', optional: true },
  });
}

function listWorker() {
  return withSchema(new ListIdentityObservationsWorker(), 'list_identity_observations', {
    domain:   { type: 'string', optional: true },
    level:    { type: 'number', optional: true },
    category: { type: 'string', optional: true },
    limit:    { type: 'number', optional: true },
  });
}

function searchWorker() {
  return withSchema(new SearchIdentityObservationsWorker(), 'search_identity_observations', {
    query:            { type: 'string' },
    domain:           { type: 'string', optional: true },
    limit:            { type: 'number', optional: true },
    include_archived: { type: 'boolean', optional: true },
  });
}

function removeWorker() {
  return withSchema(new RemoveIdentityObservationWorker(), 'remove_identity_observation', {
    id: { type: 'string' },
  });
}

function row(overrides: Record<string, any> = {}) {
  return {
    id:         'hum1',
    domain:     'human',
    level:      3,
    category:   'preference',
    content:    'Jonathon prefers direct status reports.',
    basis:      'He asked for direct status.',
    created_at: '2026-08-19T18:00:00.000Z',
    updated_at: null,
    archived:   false,
    source:     null,
    ...overrides,
  };
}

describe('identity observation tools', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('adds a new identity observation when no duplicate exists', async() => {
    jest.spyOn(IdentityObservationsModel, 'findDuplicate').mockResolvedValue(null);
    jest.spyOn(IdentityObservationsModel, 'insert').mockResolvedValue(row());

    const result = await addWorker().invoke({
      domain:   'human',
      level:    3,
      category: 'preference',
      content:  'Jonathon prefers direct status reports.',
      basis:    'He asked for direct status.',
    });

    expect(result.success).toBe(true);
    expect(result.result).toContain('Remembering:');
    expect(IdentityObservationsModel.insert).toHaveBeenCalledWith({
      domain:   'human',
      level:    3,
      category: 'preference',
      content:  'Jonathon prefers direct status reports.',
      basis:    'He asked for direct status.',
      source:   undefined,
    });
  });

  it('updates an existing duplicate instead of inserting another row', async() => {
    jest.spyOn(IdentityObservationsModel, 'findDuplicate').mockResolvedValue(row({ id: 'dupe' }));
    jest.spyOn(IdentityObservationsModel, 'update').mockResolvedValue(row({ id: 'dupe' }));

    const result = await addWorker().invoke({
      level:   2,
      content: 'Jonathon prefers direct status reports.',
    });

    expect(result.success).toBe(true);
    expect(result.result).toContain('id: dupe');
    expect(IdentityObservationsModel.update).toHaveBeenCalledWith('dupe', {
      level:    2,
      category: undefined,
      content:  'Jonathon prefers direct status reports.',
      basis:    undefined,
      source:   undefined,
    });
  });

  it('lists active rows in compact certainty-first format', async() => {
    jest.spyOn(IdentityObservationsModel, 'listActive').mockResolvedValue([row()]);

    const result = await listWorker().invoke({
      domain: 'human',
      limit:  12,
    });

    expect(result.success).toBe(true);
    expect(result.result).toContain('1 active human identity observation');
    expect(result.result).toContain('[id:hum1] L3·preference 2026-08-19');
    expect(IdentityObservationsModel.listActive).toHaveBeenCalledWith('human', {
      level:    undefined,
      category: undefined,
      limit:    12,
    });
  });

  it('lists rows returned with Date timestamps', async() => {
    jest.spyOn(IdentityObservationsModel, 'listActive').mockResolvedValue([
      row({ created_at: new Date('2026-08-19T18:00:00.000Z') }),
    ]);

    const result = await listWorker().invoke({
      domain: 'human',
      limit:  12,
    });

    expect(result.success).toBe(true);
    expect(result.result).toContain('[id:hum1] L3·preference 2026-08-19');
  });

  it('searches one identity domain and reports matched rows', async() => {
    jest.spyOn(IdentityObservationsModel, 'search').mockResolvedValue([row()]);

    const result = await searchWorker().invoke({
      domain: 'human',
      query:  'status reports',
      limit:  5,
    });

    expect(result.success).toBe(true);
    expect(result.result).toContain('Found 1 human identity observation');
    expect(result.result).toContain('[id:hum1] L3·preference');
    expect(IdentityObservationsModel.search).toHaveBeenCalledWith('human', 'status reports', 5, false);
  });

  it('soft-archives an identity observation by id', async() => {
    jest.spyOn(IdentityObservationsModel, 'archive').mockResolvedValue(true);

    const result = await removeWorker().invoke({ id: 'hum1' });

    expect(result.success).toBe(true);
    expect(result.result).toContain('Archived identity observation hum1');
    expect(IdentityObservationsModel.archive).toHaveBeenCalledWith('hum1');
  });
});
