import { TextDecoder, TextEncoder } from 'node:util';
import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

const mockSetWorkflowArchived: any = jest.fn();

jest.unstable_mockModule('../../../services/N8nService', () => ({
  createN8nService: jest.fn(async() => ({
    setWorkflowArchived: mockSetWorkflowArchived,
  })),
}));

async function loadArchiveTool() {
  return import('../archive_workflow');
}

function configureWorker(worker: any, registration: any) {
  worker.name = registration.name;
  worker.description = registration.description;
  worker.schemaDef = registration.schemaDef;
  return worker;
}

describe('archive_workflow tool', () => {
  beforeAll(() => {
    (globalThis as any).TextEncoder = TextEncoder;
    (globalThis as any).TextDecoder = TextDecoder;
  });

  afterEach(() => {
    mockSetWorkflowArchived.mockReset();
  });

  it('archives by default when action is omitted', async() => {
    const { ArchiveWorkflowWorker, archiveWorkflowRegistration } = await loadArchiveTool();

    mockSetWorkflowArchived.mockResolvedValueOnce({
      id:        'wf-1',
      name:      'Workflow 1',
      archived:  true,
      updatedAt: new Date().toISOString(),
    });

    const worker = configureWorker(new ArchiveWorkflowWorker(), archiveWorkflowRegistration);
    const result = await worker.invoke({ id: 'wf-1' });

    if (!result.success) {
      throw new Error(String(result.result || result.error || 'archive_workflow failed unexpectedly'));
    }
    expect(result.success).toBe(true);
    expect(mockSetWorkflowArchived).toHaveBeenCalledWith('wf-1', true);
  });

  it('unarchives when action=unarchive', async() => {
    const { ArchiveWorkflowWorker, archiveWorkflowRegistration } = await loadArchiveTool();

    mockSetWorkflowArchived.mockResolvedValueOnce({
      id:        'wf-2',
      name:      'Workflow 2',
      archived:  false,
      updatedAt: new Date().toISOString(),
    });

    const worker = configureWorker(new ArchiveWorkflowWorker(), archiveWorkflowRegistration);
    const result = await worker.invoke({ id: 'wf-2', action: 'unarchive' });

    if (!result.success) {
      throw new Error(String(result.result || result.error || 'archive_workflow failed unexpectedly'));
    }
    expect(result.success).toBe(true);
    expect(mockSetWorkflowArchived).toHaveBeenCalledWith('wf-2', false);
  });

  it('returns error on invalid action', async() => {
    const { ArchiveWorkflowWorker, archiveWorkflowRegistration } = await loadArchiveTool();

    const worker = configureWorker(new ArchiveWorkflowWorker(), archiveWorkflowRegistration);
    await expect(worker.invoke({ id: 'wf-3', action: 'invalid' })).rejects.toThrow('Invalid value for action: must be one of archive, unarchive');
  });
});
