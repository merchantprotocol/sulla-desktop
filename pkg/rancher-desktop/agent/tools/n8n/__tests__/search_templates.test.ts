import { TextDecoder, TextEncoder } from 'node:util';
import { beforeAll, describe, expect, it } from '@jest/globals';

let N8nServiceClass: any;

describe('search_templates production integration', () => {
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

  it('returns real templates for a simple "news" query', async() => {
    const service = new N8nServiceClass();
    const result = await service.searchTemplates({ search: 'news', limit: 10 });

    const templates = Array.isArray(result?.workflows)
      ? result.workflows
      : (Array.isArray(result?.templates) ? result.templates : []);
    const totalCount = Number(result?.totalWorkflows ?? result?.totalCount ?? templates.length ?? 0);

    expect(Number.isFinite(totalCount)).toBe(true);
    expect(totalCount).toBeGreaterThan(0);
    expect(Array.isArray(templates)).toBe(true);
    expect(templates.length).toBeGreaterThan(0);
  });
});
