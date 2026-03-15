import { afterEach, describe, expect, it, jest } from '@jest/globals';

const mockSearchTemplates: any = jest.fn();

jest.unstable_mockModule('../../../services/N8nService', () => ({
  createN8nService: jest.fn(async() => ({
    searchTemplates: mockSearchTemplates,
  })),
}));

async function loadSearchTemplatesTool() {
  return import('../search_templates');
}

function configureWorker(worker: any, registration: any) {
  worker.name = registration.name;
  worker.description = registration.description;
  worker.schemaDef = registration.schemaDef;
  return worker;
}

describe('search_templates fallback behavior', () => {
  afterEach(() => {
    mockSearchTemplates.mockReset();
  });

  it('retries with split terms and returns fallback match when initial query has zero results', async() => {
    const { SearchTemplatesWorker, searchTemplatesRegistration } = await loadSearchTemplatesTool();

    mockSearchTemplates
      .mockResolvedValueOnce({ totalWorkflows: 0, workflows: [] })
      .mockResolvedValueOnce({
        totalWorkflows: 2,
        workflows:      [
          {
            id:          'wf-1',
            name:        'Daily News Summary',
            description: 'Collect top headlines daily',
            categories:  [{ name: 'Communication' }],
          },
        ],
      });

    const worker = configureWorker(new SearchTemplatesWorker(), searchTemplatesRegistration);
    const result = await worker.invoke({
      search: 'daily news digest automation',
      limit:  10,
    });

    expect(result.success).toBe(true);
    expect(mockSearchTemplates).toHaveBeenCalledTimes(2);
    expect(mockSearchTemplates).toHaveBeenNthCalledWith(1, {
      category: undefined,
      nodes:    undefined,
      page:     undefined,
      limit:    10,
      search:   'daily news digest automation',
    });
    expect(mockSearchTemplates).toHaveBeenNthCalledWith(2, {
      category: undefined,
      nodes:    undefined,
      page:     undefined,
      limit:    10,
      search:   'daily news',
    });
    expect(result.result).toContain('fallback match via');
    expect(result.result).toContain('Daily News Summary');
  });

  it('falls back to broad search when no split terms return templates', async() => {
    const { SearchTemplatesWorker, searchTemplatesRegistration } = await loadSearchTemplatesTool();

    mockSearchTemplates
      .mockResolvedValueOnce({ totalWorkflows: 0, workflows: [] })
      .mockResolvedValue({ totalWorkflows: 0, workflows: [] });

    const worker = configureWorker(new SearchTemplatesWorker(), searchTemplatesRegistration);
    const result = await worker.invoke({
      search: 'totally nonexistent phrase query',
      limit:  5,
    });

    expect(result.success).toBe(true);
    expect(mockSearchTemplates).toHaveBeenCalled();

    const calls = mockSearchTemplates.mock.calls;
    const lastCallArgs = calls[calls.length - 1]?.[0];

    expect(lastCallArgs).toEqual({
      category: undefined,
      nodes:    undefined,
      page:     undefined,
      limit:    5,
    });
    expect(result.result).toContain('fallback match via broad template search');
  });

  it('honors requested limit when formatting returned templates', async() => {
    const { SearchTemplatesWorker, searchTemplatesRegistration } = await loadSearchTemplatesTool();

    mockSearchTemplates.mockResolvedValueOnce({
      totalWorkflows: 3,
      workflows:      [
        { id: 'wf-1', name: 'Template One', description: 'Desc 1', categories: [{ name: 'Cat A' }] },
        { id: 'wf-2', name: 'Template Two', description: 'Desc 2', categories: [{ name: 'Cat B' }] },
        { id: 'wf-3', name: 'Template Three', description: 'Desc 3', categories: [{ name: 'Cat C' }] },
      ],
    });

    const worker = configureWorker(new SearchTemplatesWorker(), searchTemplatesRegistration);
    const result = await worker.invoke({
      search: 'template test',
      limit:  2,
    });

    expect(result.success).toBe(true);
    expect(result.result).toContain('1. **Template One**');
    expect(result.result).toContain('2. **Template Two**');
    expect(result.result).not.toContain('3. **Template Three**');
    expect(result.result).toContain('... and 1 more templates');
  });
});
