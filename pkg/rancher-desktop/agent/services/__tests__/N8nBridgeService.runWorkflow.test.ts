import { TextDecoder, TextEncoder } from 'node:util';
import { beforeAll, describe, expect, it, jest } from '@jest/globals';

let N8nBridgeServiceClass: any;

describe('N8nBridgeService.runWorkflow', () => {
  beforeAll(async() => {
    (globalThis as any).TextEncoder = TextEncoder;
    (globalThis as any).TextDecoder = TextDecoder;

    const mod = await import('../N8nBridgeService');
    N8nBridgeServiceClass = mod.N8nBridgeService;
  });

  it('falls back with workflowData when n8n run endpoint throws missing nodeName error', async() => {
    const service = new N8nBridgeServiceClass();

    const requestMock = jest.fn(async(endpoint: string, options?: { method?: string; body?: string }) => {
      if (requestMock.mock.calls.length === 1) {
        expect(endpoint).toBe('/rest/workflows/wf_1/run');
        expect(options?.method).toBe('POST');
        throw new Error("n8n request failed 500 Internal Server Error: {\"code\":0,\"message\":\"Cannot read properties of undefined (reading 'nodeName')\"}");
      }

      if (requestMock.mock.calls.length === 2) {
        expect(endpoint).toBe('/rest/workflows/wf_1');
        return {
          id:   'wf_1',
          data: {
            name:        'Workflow One',
            nodes:       [],
            connections: {},
            settings:    {},
          },
        };
      }

      if (requestMock.mock.calls.length === 3) {
        expect(endpoint).toBe('/rest/workflows/wf_1/run');
        const payload = JSON.parse(String(options?.body || '{}'));
        expect(payload.workflowData).toBeDefined();
        expect(payload.workflowData.id).toBe('wf_1');
        return { executionId: 'exec_123' };
      }

      throw new Error(`Unexpected request call: ${ endpoint }`);
    });

    service.request = requestMock;

    const result = await service.runWorkflow('wf_1', {});

    expect(result).toEqual({ executionId: 'exec_123' });
    expect(requestMock).toHaveBeenCalledTimes(3);
    expect(requestMock.mock.calls.map((call: any[]) => call[0])).not.toContain('/rest/workflows/run');
  });

  it('falls back to /rest/workflows/run when workflow-specific retry endpoint is not found', async() => {
    const service = new N8nBridgeServiceClass();

    const requestMock = jest.fn(async(endpoint: string, options?: { method?: string; body?: string }) => {
      if (requestMock.mock.calls.length === 1) {
        throw new Error("n8n request failed 500 Internal Server Error: {\"code\":0,\"message\":\"Cannot read properties of undefined (reading 'nodeName')\"}");
      }

      if (requestMock.mock.calls.length === 2) {
        return {
          id:   'wf_2',
          data: {
            id:          'wf_2',
            nodes:       [],
            connections: {},
            settings:    {},
          },
        };
      }

      if (requestMock.mock.calls.length === 3) {
        expect(endpoint).toBe('/rest/workflows/wf_2/run');
        throw new Error('n8n request failed 404 Not Found: Cannot POST /rest/workflows/wf_2/run');
      }

      if (requestMock.mock.calls.length === 4) {
        expect(endpoint).toBe('/rest/workflows/run');
        const payload = JSON.parse(String(options?.body || '{}'));
        expect(payload.workflowData.id).toBe('wf_2');
        return { executionId: 'exec_legacy' };
      }

      throw new Error(`Unexpected request call: ${ endpoint }`);
    });

    service.request = requestMock;

    const result = await service.runWorkflow('wf_2', {});

    expect(result).toEqual({ executionId: 'exec_legacy' });
    expect(requestMock).toHaveBeenCalledTimes(4);
  });

  it('surfaces workflow-specific retry error when legacy /rest/workflows/run is unsupported', async() => {
    const service = new N8nBridgeServiceClass();
    const workflowId = 'EQhRGIv6zeJQ9AgU';
    const workflowRetryError = "n8n request failed 500 Internal Server Error: {\"code\":0,\"message\":\"Cannot read properties of undefined (reading 'nodeName')\"}";

    const requestMock = jest.fn(async(endpoint: string) => {
      if (requestMock.mock.calls.length === 1) {
        throw new Error(workflowRetryError);
      }

      if (requestMock.mock.calls.length === 2) {
        return {
          id:   workflowId,
          data: {
            id:          workflowId,
            nodes:       [],
            connections: {},
            settings:    {},
          },
        };
      }

      if (requestMock.mock.calls.length === 3) {
        throw new Error(workflowRetryError);
      }

      if (requestMock.mock.calls.length === 4) {
        expect(endpoint).toBe('/rest/workflows/run');
        throw new Error('n8n request failed 404 Not Found: Cannot POST /rest/workflows/run');
      }

      throw new Error(`Unexpected request call: ${ endpoint }`);
    });

    service.request = requestMock;

    await expect(service.runWorkflow(workflowId, {})).rejects.toThrow("Cannot read properties of undefined (reading 'nodeName')");
    expect(requestMock).toHaveBeenCalledTimes(4);
  });

  it('falls back to /rest/workflows/run when workflow-specific retry still throws missing id/nodeName errors', async() => {
    const service = new N8nBridgeServiceClass();
    const workflowId = 'EQhRGIv6zeJQ9AgU';

    const requestMock = jest.fn(async(endpoint: string, options?: { method?: string; body?: string }) => {
      if (requestMock.mock.calls.length === 1) {
        expect(endpoint).toBe(`/rest/workflows/${ workflowId }/run`);
        throw new Error("n8n request failed 500 Internal Server Error: {\"code\":0,\"message\":\"Cannot read properties of undefined (reading 'nodeName')\"}");
      }

      if (requestMock.mock.calls.length === 2) {
        expect(endpoint).toBe(`/rest/workflows/${ workflowId }`);
        return {
          id:   workflowId,
          data: {
            id:          workflowId,
            name:        'Daily AI Intelligence Monitor',
            nodes:       [],
            connections: {},
            settings:    {},
          },
        };
      }

      if (requestMock.mock.calls.length === 3) {
        expect(endpoint).toBe(`/rest/workflows/${ workflowId }/run`);
        throw new Error("n8n request failed 500 Internal Server Error: {\"code\":0,\"message\":\"Cannot read properties of undefined (reading 'id')\"}");
      }

      if (requestMock.mock.calls.length === 4) {
        expect(endpoint).toBe('/rest/workflows/run');
        const payload = JSON.parse(String(options?.body || '{}'));
        expect(payload.workflowData.id).toBe(workflowId);
        return { executionId: 'exec_prod_recovered' };
      }

      throw new Error(`Unexpected request call: ${ endpoint }`);
    });

    service.request = requestMock;

    const result = await service.runWorkflow(workflowId, {});

    expect(result).toEqual({ executionId: 'exec_prod_recovered' });
    expect(requestMock).toHaveBeenCalledTimes(4);
  });
});
