import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { postgresClient } from '../../PostgresClient';
import { WorkProjectPipelineTemplateModel } from '../WorkProjectPipelineTemplateModel';

describe('WorkProjectPipelineTemplateModel.update', () => {
  const originalQueryOne = postgresClient.queryOne;
  const originalTransaction = postgresClient.transaction;

  afterEach(() => {
    (postgresClient as any).queryOne = originalQueryOne;
    (postgresClient as any).transaction = originalTransaction;
    jest.restoreAllMocks();
  });

  it('rejects editing a locked/system template before opening a transaction', async() => {
    (postgresClient as any).queryOne = jest.fn(() => Promise.resolve({
      id: 'core-project-template-default', locked: true, system: true,
    }));
    const transaction = jest.spyOn(postgresClient, 'transaction');

    await expect(WorkProjectPipelineTemplateModel.update('core-project-template-default', { name: 'Renamed' }))
      .rejects.toThrow('cannot be edited');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects a missing template', async() => {
    (postgresClient as any).queryOne = jest.fn(() => Promise.resolve(null));

    await expect(WorkProjectPipelineTemplateModel.update('missing', { name: 'x' }))
      .rejects.toThrow('Pipeline template not found');
  });

  it('rejects duplicate stage keys before opening a transaction', async() => {
    (postgresClient as any).queryOne = jest.fn(() => Promise.resolve({ id: 'custom', locked: false, system: false }));
    const transaction = jest.spyOn(postgresClient, 'transaction');

    await expect(WorkProjectPipelineTemplateModel.update('custom', {
      stages: [
        { stageKey: 'a', displayName: 'A', position: 10 },
        { stageKey: 'a', displayName: 'A again', position: 20 },
      ],
    })).rejects.toThrow('stage keys must be unique');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects duplicate stage positions before opening a transaction', async() => {
    (postgresClient as any).queryOne = jest.fn(() => Promise.resolve({ id: 'custom', locked: false, system: false }));
    const transaction = jest.spyOn(postgresClient, 'transaction');

    await expect(WorkProjectPipelineTemplateModel.update('custom', {
      stages: [
        { stageKey: 'a', displayName: 'A', position: 10 },
        { stageKey: 'b', displayName: 'B', position: 10 },
      ],
    })).rejects.toThrow('stage positions must be unique');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects replacing stages with an empty list', async() => {
    (postgresClient as any).queryOne = jest.fn(() => Promise.resolve({ id: 'custom', locked: false, system: false }));

    await expect(WorkProjectPipelineTemplateModel.update('custom', { stages: [] }))
      .rejects.toThrow('requires at least one stage');
  });

  it('renames without deleting stages when stages are omitted', async() => {
    (postgresClient as any).queryOne = (jest.fn() as any)
      .mockResolvedValueOnce({ id: 'custom', locked: false, system: false })
      .mockResolvedValueOnce({ id: 'custom', name: 'Renamed' });
    (postgresClient as any).query = jest.fn(() => Promise.resolve([]));
    const clientQuery = jest.fn(() => Promise.resolve({ rows: [] }));
    (postgresClient as any).transaction = (jest.fn() as any).mockImplementation((cb: any) => cb({ query: clientQuery }));

    await WorkProjectPipelineTemplateModel.update('custom', { name: 'Renamed' });

    const sqlCalls = clientQuery.mock.calls.map((call: any) => String(call[0]));
    expect(sqlCalls.some(sql => sql.includes('UPDATE work_project_pipeline_templates'))).toBe(true);
    expect(sqlCalls.some(sql => sql.includes('DELETE FROM work_project_pipeline_template_stages'))).toBe(false);
  });

  it('replaces stages transactionally when a full stage set is provided', async() => {
    (postgresClient as any).queryOne = (jest.fn() as any)
      .mockResolvedValueOnce({ id: 'custom', locked: false, system: false })
      .mockResolvedValueOnce({ id: 'custom', name: 'custom' });
    (postgresClient as any).query = jest.fn(() => Promise.resolve([]));
    const clientQuery = jest.fn(() => Promise.resolve({ rows: [] }));
    (postgresClient as any).transaction = (jest.fn() as any).mockImplementation((cb: any) => cb({ query: clientQuery }));

    await WorkProjectPipelineTemplateModel.update('custom', {
      stages: [{ stageKey: 'research', displayName: 'Research', position: 10 }],
    });

    const sqlCalls = clientQuery.mock.calls.map((call: any) => String(call[0]));
    expect(sqlCalls.some(sql => sql.includes('DELETE FROM work_project_pipeline_template_stages'))).toBe(true);
    expect(sqlCalls.some(sql => sql.includes('INSERT INTO work_project_pipeline_template_stages'))).toBe(true);
  });
});
