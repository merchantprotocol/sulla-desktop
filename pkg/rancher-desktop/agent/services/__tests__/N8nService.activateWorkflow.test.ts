import { TextDecoder, TextEncoder } from 'node:util';

import { beforeAll, describe, expect, it, jest } from '@jest/globals';

let N8nServiceClass: any;

describe('N8nService.activateWorkflow', () => {
  beforeAll(async() => {
    (globalThis as any).TextEncoder = TextEncoder;
    (globalThis as any).TextDecoder = TextDecoder;
    const mod = await import('../N8nService');
    N8nServiceClass = mod.N8nService;
  });

  it('falls back to PATCH /workflows/:id when /activate returns 404', async() => {
    const service = new N8nServiceClass();

    let callCount = 0;
    const requestMock = jest.fn(async() => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error('N8n API error 404: Not Found');
      }
      return { id: 'wf_1', active: true };
    });

    service.request = requestMock;

    const result = await service.activateWorkflow('  wf_1  ', { versionId: 'v_1' });

    expect(result).toEqual({ id: 'wf_1', active: true });
    expect(requestMock).toHaveBeenCalledTimes(2);
    const calls = (requestMock as any).mock.calls as any[];
    expect(calls[0][0]).toBe('/api/v1/workflows/wf_1/activate');
    expect(calls[0][1]).toEqual({
      method: 'POST',
      body:   JSON.stringify({ versionId: 'v_1' }),
    });
    expect(calls[1][0]).toBe('/api/v1/workflows/wf_1');
    expect(calls[1][1]).toEqual({
      method: 'PATCH',
      body:   JSON.stringify({ active: true }),
    });
  });

  it('falls back to PUT /workflows/:id with active=true when PATCH fallback is not allowed', async() => {
    const service = new N8nServiceClass();

    let callCount = 0;
    const existingWorkflow = {
      id:          'wf_put_1',
      name:        'Workflow A',
      nodes:       [],
      connections: {},
      settings:    {},
      active:      false,
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
          ...existingWorkflow,
          active: true,
        });
        return { id: 'wf_put_1', active: true };
      }

      return { id: 'wf_put_1', active: true };
    });

    service.request = requestMock;

    const result = await service.activateWorkflow('wf_put_1');

    expect(result).toEqual({ id: 'wf_put_1', active: true });
    expect(requestMock).toHaveBeenCalledTimes(4);
    const calls = (requestMock as any).mock.calls as any[];
    expect(calls[0][0]).toBe('/api/v1/workflows/wf_put_1/activate');
    expect(calls[0][1]).toEqual({ method: 'POST' });
    expect(calls[1][0]).toBe('/api/v1/workflows/wf_put_1');
    expect(calls[1][1]).toEqual({ method: 'PATCH', body: JSON.stringify({ active: true }) });
    expect(calls[2][0]).toBe('/api/v1/workflows/wf_put_1');
    expect(calls[2][1]).toBeUndefined();
    expect(calls[3][0]).toBe('/api/v1/workflows/wf_put_1');
    expect(calls[3][1]).toEqual({
      method: 'PUT',
      body:   JSON.stringify({
        ...existingWorkflow,
        active: true,
      }),
    });
  });

  it('rethrows non-404 activation errors', async() => {
    const service = new N8nServiceClass();

    const requestMock = jest.fn(async() => {
      throw new Error('N8n API error 500: Internal Server Error');
    });

    service.request = requestMock;

    await expect(service.activateWorkflow('wf_2')).rejects.toThrow('N8n API error 500');
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('throws for blank workflow IDs', async() => {
    const service = new N8nServiceClass();
    await expect(service.activateWorkflow('   ')).rejects.toThrow('Workflow ID is required for activation');
  });
});
