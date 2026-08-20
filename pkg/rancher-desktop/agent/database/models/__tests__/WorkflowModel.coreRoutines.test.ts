import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { postgresClient } from '../../PostgresClient';
import { WorkflowHistoryModel } from '../WorkflowHistoryModel';
import { hashRoutineDefinition, LockedRoutineError, WorkflowModel } from '../WorkflowModel';

/**
 * Locked core-routine behavior:
 *   - hashRoutineDefinition is order-stable
 *   - system rows refuse edit/delete/status from any non-seeder caller
 *   - seedCoreRoutine is idempotent + self-healing and preserves `enabled`
 */
describe('WorkflowModel — locked core routines', () => {
  const DEF = { id: 'core-routine-x', name: 'X', nodes: [], edges: [], enabled: true };

  let originalQuery: any;
  let originalQueryOne: any;
  let lastInsertParams: any[] | null;

  beforeEach(() => {
    originalQuery = (postgresClient as any).query;
    originalQueryOne = (postgresClient as any).queryOne;
    lastInsertParams = null;
    jest.spyOn(WorkflowHistoryModel, 'recordChange').mockResolvedValue(undefined as any);
  });

  afterEach(() => {
    (postgresClient as any).query = originalQuery;
    (postgresClient as any).queryOne = originalQueryOne;
    jest.restoreAllMocks();
  });

  // Build a queryOne router around a simulated existing row (or null).
  function stubDb(existing: Record<string, any> | null) {
    (postgresClient as any).queryOne = jest.fn((sql: string, params: any[]) => {
      if (sql.includes('SELECT system FROM workflows')) {
        return Promise.resolve(existing ? { system: existing.system === true } : null);
      }
      if (sql.includes('SELECT * FROM workflows')) {
        return Promise.resolve(existing);
      }
      if (sql.includes('INSERT INTO workflows')) {
        lastInsertParams = params;
        // Echo a row shaped from the insert params (col order matches the model).
        return Promise.resolve({
          id: params[0], name: params[1], description: params[2], version: params[3],
          status: params[4], definition: JSON.parse(params[5]), enabled: params[6],
          source_template_slug: params[7], system: params[8], content_hash: params[9],
        });
      }
      if (sql.includes('UPDATE workflows')) {
        return Promise.resolve({ ...existing, status: params[1] });
      }
      return Promise.resolve(null);
    });
    (postgresClient as any).query = jest.fn(() => Promise.resolve([{ id: existing?.id }]));
  }

  it('hashRoutineDefinition ignores key order', () => {
    const a = hashRoutineDefinition({ id: 'x', name: 'n', nodes: [{ a: 1, b: 2 }] });
    const b = hashRoutineDefinition({ nodes: [{ b: 2, a: 1 }], name: 'n', id: 'x' });
    expect(a).toBe(b);
    const c = hashRoutineDefinition({ id: 'x', name: 'CHANGED', nodes: [] });
    expect(c).not.toBe(a);
  });

  it('refuses to delete a system row unless the seeder asks', async() => {
    stubDb({ id: DEF.id, system: true, enabled: true });
    await expect(WorkflowModel.deleteById(DEF.id)).rejects.toBeInstanceOf(LockedRoutineError);
    // seeder bypass is allowed
    await expect(WorkflowModel.deleteById(DEF.id, { actor: 'seeder' })).resolves.toBe(true);
  });

  it('refuses to edit or re-status a system row from a user caller', async() => {
    stubDb({ id: DEF.id, system: true, enabled: true, status: 'production', definition: DEF });
    await expect(WorkflowModel.upsertFromDefinition(DEF)).rejects.toBeInstanceOf(LockedRoutineError);
    await expect(WorkflowModel.updateStatus(DEF.id, 'archive')).rejects.toBeInstanceOf(LockedRoutineError);
  });

  it('seedCoreRoutine inserts when absent and marks the row system', async() => {
    stubDb(null);
    const result = await WorkflowModel.seedCoreRoutine(DEF);
    expect(result).toBe('inserted');
    expect(lastInsertParams?.[8]).toBe(true);                       // system column
    expect(lastInsertParams?.[9]).toBe(hashRoutineDefinition(DEF)); // content_hash column
  });

  it('seedCoreRoutine is a no-op when the hash already matches', async() => {
    stubDb({ id: DEF.id, system: true, content_hash: hashRoutineDefinition(DEF), enabled: true, definition: DEF });
    const result = await WorkflowModel.seedCoreRoutine(DEF);
    expect(result).toBe('unchanged');
    expect(lastInsertParams).toBeNull(); // never wrote
  });

  it('seedCoreRoutine re-syncs on drift and preserves the human disable choice', async() => {
    stubDb({ id: DEF.id, system: true, content_hash: 'stale-hash', enabled: false, definition: { old: true } });
    const result = await WorkflowModel.seedCoreRoutine(DEF);
    expect(result).toBe('resynced');
    expect(lastInsertParams?.[6]).toBe(false); // enabled preserved from the existing (paused) row
    expect(lastInsertParams?.[9]).toBe(hashRoutineDefinition(DEF));
  });
});
