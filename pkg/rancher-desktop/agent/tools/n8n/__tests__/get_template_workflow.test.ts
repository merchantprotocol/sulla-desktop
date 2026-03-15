import { TextDecoder, TextEncoder } from 'node:util';
import { beforeAll, describe, expect, it } from '@jest/globals';

let N8nServiceClass: any;

describe('get_template_workflow production integration', () => {
  beforeAll(async() => {
    (globalThis as any).TextEncoder = TextEncoder;
    (globalThis as any).TextDecoder = TextDecoder;

    if (!(globalThis as any).fetch) {
      const nodeFetch = await import('node-fetch');
      (globalThis as any).fetch = nodeFetch.default;
    }

    const mod = await import('../../../services/N8nService');
    N8nServiceClass = mod.N8nService;
  });

  it('returns non-empty template workflow payload for a real template id from public search', async() => {
    const service = new N8nServiceClass();

    const searchResult = await service.searchTemplates({ search: 'news', limit: 10 });
    const templates = Array.isArray(searchResult?.workflows)
      ? searchResult.workflows
      : (Array.isArray(searchResult?.templates) ? searchResult.templates : []);

    expect(Array.isArray(templates)).toBe(true);
    expect(templates.length).toBeGreaterThan(0);

    const templateWithId = templates.find((template: any) => {
      const numericId = Number(template?.id);
      return Number.isFinite(numericId) && numericId > 0;
    });

    expect(templateWithId).toBeDefined();

    const templateId = Number(templateWithId.id);
    const templateWorkflow = await service.getTemplateWorkflow(templateId);

    expect(templateWorkflow).toBeTruthy();
    expect(typeof templateWorkflow).toBe('object');
    expect(Array.isArray(templateWorkflow)).toBe(false);
    expect(Object.keys(templateWorkflow).length).toBeGreaterThan(0);

    const hasUsefulFields = Boolean(
      templateWorkflow.id ||
      templateWorkflow.name ||
      templateWorkflow.description ||
      (Array.isArray(templateWorkflow.nodes) && templateWorkflow.nodes.length > 0),
    );

    expect(hasUsefulFields).toBe(true);
  }, 60000);
});
