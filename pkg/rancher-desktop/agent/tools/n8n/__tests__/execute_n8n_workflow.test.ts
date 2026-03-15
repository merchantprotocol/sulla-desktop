import { TextDecoder, TextEncoder } from 'node:util';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

const mockRunWorkflow: any = jest.fn();
const mockBridgeRequest: any = jest.fn();

const runtimeServiceMockFactory = () => ({
  getN8nRuntime: jest.fn(async() => ({
    bridge: {
      runWorkflow: mockRunWorkflow,
      request:     mockBridgeRequest,
    },
  })),
});

jest.unstable_mockModule('../../../services/N8nRuntimeService', runtimeServiceMockFactory);
jest.unstable_mockModule('../../../services/N8nRuntimeService.ts', runtimeServiceMockFactory);

async function loadExecuteTool() {
  return import('../execute_n8n_workflow');
}

function configureWorker(worker: any, registration: any) {
  worker.name = registration.name;
  worker.description = registration.description;
  worker.schemaDef = registration.schemaDef;
  return worker;
}

describe('execute_n8n_workflow tool', () => {
  beforeAll(async() => {
    (globalThis as any).TextEncoder = TextEncoder;
    (globalThis as any).TextDecoder = TextDecoder;

    if (!(globalThis as any).fetch) {
      const nodeFetch = await import('node-fetch');
      (globalThis as any).fetch = nodeFetch.default;
    }

    const settingsDir = await mkdtemp(join(tmpdir(), 'sulla-settings-'));
    const fallbackPath = join(settingsDir, 'installation-lock.json');
    await writeFile(fallbackPath, '{}', 'utf8');

    const settingsMod = await import('../../../database/models/SullaSettingsModel');
    settingsMod.SullaSettingsModel.setFallbackFilePath(fallbackPath);
    await settingsMod.SullaSettingsModel.bootstrap();
  });

  afterEach(() => {
    mockRunWorkflow.mockReset();
    mockBridgeRequest.mockReset();
  });

  it('returns failure in async mode when execution is already failed', async() => {
    const { ExecuteN8nWorkflowBridgeWorker, executeN8nWorkflowBridgeRegistration } = await loadExecuteTool();

    mockRunWorkflow.mockResolvedValueOnce({ executionId: 'exec_async_fail' });
    mockBridgeRequest.mockResolvedValueOnce({
      id:     'exec_async_fail',
      status: 'error',
      data:   {
        resultData: {
          error: {
            message: "Problem in node 'Merge All Sources': Cannot read properties of undefined (reading 'execute')",
          },
        },
      },
    });

    const worker = configureWorker(new ExecuteN8nWorkflowBridgeWorker(), executeN8nWorkflowBridgeRegistration);
    const result = await worker.invoke({ workflowId: 'EQhRGIv6zeJQ9AgU', mode: 'async' });

    expect(result.success).toBe(false);
    expect(String(result.result || '')).toContain("Cannot read properties of undefined (reading 'execute')");
  });

  it('returns failure in sync mode when execution ends with error status', async() => {
    const { ExecuteN8nWorkflowBridgeWorker, executeN8nWorkflowBridgeRegistration } = await loadExecuteTool();

    mockRunWorkflow.mockResolvedValueOnce({ executionId: 'exec_sync_fail' });
    mockBridgeRequest.mockResolvedValueOnce({
      id:     'exec_sync_fail',
      status: 'failed',
      data:   {
        resultData: {
          error: {
            message: 'Node execution failed hard',
          },
        },
      },
      finishedAt: '2026-02-26T08:00:00.000Z',
    });

    const worker = configureWorker(new ExecuteN8nWorkflowBridgeWorker(), executeN8nWorkflowBridgeRegistration);
    const result = await worker.invoke({ workflowId: 'wf_sync_fail', mode: 'sync', timeoutMs: 1000 });

    expect(result.success).toBe(false);
    expect(String(result.result || '')).toContain('Node execution failed hard');
  });

  it('returns failure when run endpoint does not return executionId', async() => {
    const { ExecuteN8nWorkflowBridgeWorker, executeN8nWorkflowBridgeRegistration } = await loadExecuteTool();

    mockRunWorkflow.mockResolvedValueOnce({ ok: true });

    const worker = configureWorker(new ExecuteN8nWorkflowBridgeWorker(), executeN8nWorkflowBridgeRegistration);
    const result = await worker.invoke({ workflowId: 'wf_missing_id', mode: 'async' });

    expect(result.success).toBe(false);
    expect(String(result.result || '')).toContain('did not return executionId');
  });
});
