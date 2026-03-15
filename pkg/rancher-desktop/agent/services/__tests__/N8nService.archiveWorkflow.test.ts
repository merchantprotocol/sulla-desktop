import { TextDecoder, TextEncoder } from 'node:util';
import { beforeAll, describe, expect, it, jest } from '@jest/globals';

let N8nServiceClass: any;

describe('N8nService.setWorkflowArchived', () => {
  beforeAll(async() => {
    (globalThis as any).TextEncoder = TextEncoder;
    (globalThis as any).TextDecoder = TextDecoder;
    const mod = await import('../N8nService');
    N8nServiceClass = mod.N8nService;
  });

  it('archives with POST /workflows/:id/archive on supported APIs', async() => {
    const service = new N8nServiceClass();

    const requestMock = jest.fn(async(_url: string, _init?: { method?: string; body?: string }) => ({ id: 'wf_1', archived: true }));
    service.request = requestMock;

    const result = await service.setWorkflowArchived(' wf_1 ', true);

    expect(result).toEqual({ id: 'wf_1', archived: true });
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledWith('/api/v1/workflows/wf_1/archive', { method: 'POST' });
  });

  it('unarchives with POST /workflows/:id/unarchive on supported APIs', async() => {
    const service = new N8nServiceClass();

    const requestMock = jest.fn(async() => {
      return { id: 'wf_2', archived: false };
    });

    service.request = requestMock;

    const result = await service.setWorkflowArchived('wf_2', false);

    expect(result).toEqual({ id: 'wf_2', archived: false });
    expect(requestMock).toHaveBeenCalledTimes(1);
    const calls = (requestMock as any).mock.calls as any[];
    expect(calls[0][0]).toBe('/api/v1/workflows/wf_2/unarchive');
    expect(calls[0][1]).toEqual({ method: 'POST' });
  });

  it('falls back to PUT /workflows/:id when PATCH fallback is not allowed', async() => {
    const service = new N8nServiceClass();

    let callCount = 0;
    const existingWorkflow = {
      id:          'wf_put_1',
      name:        'Workflow A',
      nodes:       [],
      connections: {},
      settings:    {},
      archived:    false,
    };

    const requestMock = jest.fn(async(url: string, init?: { method?: string; body?: string }) => {
      callCount += 1;

      if (callCount === 1) {
        throw new Error('N8n API error 405: Method Not Allowed');
      }

      if (callCount === 2) {
        throw new Error('N8n API error 405: Method Not Allowed');
      }

      if (callCount === 3) {
        expect(url).toBe('/api/v1/workflows/wf_put_1');
        expect(init).toBeUndefined();
        return existingWorkflow;
      }

      if (callCount === 4) {
        expect(url).toBe('/api/v1/workflows/wf_put_1');
        expect(init?.method).toBe('PUT');
        expect(JSON.parse(init?.body || '{}')).toEqual({
          name:        existingWorkflow.name,
          nodes:       existingWorkflow.nodes,
          connections: existingWorkflow.connections,
          settings:    existingWorkflow.settings,
          archived:    true,
        });
        return { id: 'wf_put_1', archived: true };
      }

      return { id: 'wf_put_1', archived: true };
    });

    service.request = requestMock;

    const result = await service.archiveWorkflow('wf_put_1');

    expect(result).toEqual({ id: 'wf_put_1', archived: true });
    expect(requestMock).toHaveBeenCalledTimes(4);
    const calls = (requestMock as any).mock.calls as any[];
    expect(calls[0][0]).toBe('/api/v1/workflows/wf_put_1/archive');
    expect(calls[0][1]).toEqual({ method: 'POST' });
    expect(calls[1][0]).toBe('/api/v1/workflows/wf_put_1');
    expect(calls[1][1]).toEqual({ method: 'PATCH', body: JSON.stringify({ archived: true }) });
    expect(calls[2][0]).toBe('/api/v1/workflows/wf_put_1');
    expect(calls[2][1]).toBeUndefined();
    expect(calls[3][0]).toBe('/api/v1/workflows/wf_put_1');
    expect(calls[3][1]).toEqual({
      method: 'PUT',
      body:   JSON.stringify({
        name:        existingWorkflow.name,
        nodes:       existingWorkflow.nodes,
        connections: existingWorkflow.connections,
        settings:    existingWorkflow.settings,
        archived:    true,
      }),
    });
  });

  it('falls back to PUT when PATCH returns 400 additional-properties schema mismatch', async() => {
    const service = new N8nServiceClass();

    let callCount = 0;
    const existingWorkflow = {
      id:          'wf_put_2',
      name:        'Workflow B',
      nodes:       [],
      connections: {},
      settings:    {},
      archived:    false,
    };

    const requestMock = jest.fn(async(url: string, init?: { method?: string; body?: string }) => {
      callCount += 1;

      if (callCount === 1) {
        throw new Error('N8n API error 405: Method Not Allowed');
      }

      if (callCount === 2) {
        throw new Error('N8n API error 400: Bad Request - {"message":"request/body must NOT have additional properties"}');
      }

      if (callCount === 3) {
        expect(url).toBe('/api/v1/workflows/wf_put_2');
        expect(init).toBeUndefined();
        return existingWorkflow;
      }

      if (callCount === 4) {
        expect(url).toBe('/api/v1/workflows/wf_put_2');
        expect(init?.method).toBe('PUT');
        expect(JSON.parse(init?.body || '{}')).toEqual({
          name:        existingWorkflow.name,
          nodes:       existingWorkflow.nodes,
          connections: existingWorkflow.connections,
          settings:    existingWorkflow.settings,
          archived:    true,
        });
        return { id: 'wf_put_2', archived: true };
      }

      return { id: 'wf_put_2', archived: true };
    });

    service.request = requestMock;

    const result = await service.archiveWorkflow('wf_put_2');

    expect(result).toEqual({ id: 'wf_put_2', archived: true });
    expect(requestMock).toHaveBeenCalledTimes(4);
    const calls = (requestMock as any).mock.calls as any[];
    expect(calls[0][0]).toBe('/api/v1/workflows/wf_put_2/archive');
    expect(calls[0][1]).toEqual({ method: 'POST' });
    expect(calls[1][0]).toBe('/api/v1/workflows/wf_put_2');
    expect(calls[1][1]).toEqual({ method: 'PATCH', body: JSON.stringify({ archived: true }) });
    expect(calls[2][0]).toBe('/api/v1/workflows/wf_put_2');
    expect(calls[2][1]).toBeUndefined();
    expect(calls[3][0]).toBe('/api/v1/workflows/wf_put_2');
    expect(calls[3][1]).toEqual({
      method: 'PUT',
      body:   JSON.stringify({
        name:        existingWorkflow.name,
        nodes:       existingWorkflow.nodes,
        connections: existingWorkflow.connections,
        settings:    existingWorkflow.settings,
        archived:    true,
      }),
    });
  });

  it('throws for blank workflow IDs', async() => {
    const service = new N8nServiceClass();
    await expect(service.setWorkflowArchived('  ', true)).rejects.toThrow('Workflow ID is required for archive state change');
  });
});
