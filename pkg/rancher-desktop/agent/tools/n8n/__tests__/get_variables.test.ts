import { afterEach, describe, expect, it, jest } from '@jest/globals';

const mockGetVariables: any = jest.fn();
const mockInitialize: any = jest.fn();
const mockQuery: any = jest.fn();

jest.unstable_mockModule('../../../services/N8nService', () => ({
  createN8nService: jest.fn(async() => ({
    getVariables: mockGetVariables,
  })),
}));

jest.unstable_mockModule('../../../database/PostgresClient', () => ({
  postgresClient: {
    initialize: mockInitialize,
    query:      mockQuery,
  },
}));

async function loadGetVariablesTool() {
  return import('../get_variables');
}

function configureWorker(worker: any, registration: any) {
  worker.name = registration.name;
  worker.description = registration.description;
  worker.schemaDef = registration.schemaDef;
  return worker;
}

describe('get_variables tool fallback behavior', () => {
  afterEach(() => {
    mockGetVariables.mockReset();
    mockInitialize.mockReset();
    mockQuery.mockReset();
  });

  it('falls back to postgres when n8n variables endpoint is blocked by license', async() => {
    const { GetVariablesWorker, getVariablesRegistration } = await loadGetVariablesTool();

    mockGetVariables.mockRejectedValueOnce(
      new Error('N8n API error 403: Forbidden - {"message":"Your license does not allow for feat:variables"}'),
    );
    mockInitialize.mockResolvedValueOnce(undefined);
    mockQuery.mockResolvedValueOnce([
      {
        id:        'var-1',
        key:       'API_TOKEN',
        value:     'secret',
        projectId: null,
        createdAt: null,
        updatedAt: null,
      },
    ]);

    const worker = configureWorker(new GetVariablesWorker(), getVariablesRegistration);
    const result = await worker.invoke({ limit: 10 });

    expect(result.success).toBe(true);
    expect(mockInitialize).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(result.result).toContain('fallback via PostgreSQL');
    expect(result.result).toContain('Key: API_TOKEN');
  });

  it('returns service error when failure is not a variables license error', async() => {
    const { GetVariablesWorker, getVariablesRegistration } = await loadGetVariablesTool();

    mockGetVariables.mockRejectedValueOnce(new Error('N8n API error 500: Internal Server Error'));

    const worker = configureWorker(new GetVariablesWorker(), getVariablesRegistration);
    const result = await worker.invoke({});

    expect(result.success).toBe(false);
    expect(result.result).toContain('Error getting variables: N8n API error 500');
    expect(mockInitialize).not.toHaveBeenCalled();
  });
});
