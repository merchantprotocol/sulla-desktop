import { describe, expect, it } from '@jest/globals';

import { ToolRegistry } from '../registry';

describe('ToolRegistry.searchTools', () => {
  function makeRegistry() {
    const registry = new ToolRegistry() as any;

    registry.categories.set('n8n', ['get_workflows']);
    registry.categories.set('pg', ['pg_execute']);

    registry.descriptions.set('get_workflows', 'Get workflows from n8n');
    registry.descriptions.set('pg_execute', 'Execute a PostgreSQL statement and return execution results.');

    registry.loaders.set('get_workflows', async() => ({
      name:        'get_workflows',
      description: 'Get workflows from n8n',
      jsonSchema:  { type: 'object', properties: {} },
    }));
    registry.loaders.set('pg_execute', async() => ({
      name:        'pg_execute',
      description: 'Execute a PostgreSQL statement and return execution results.',
      jsonSchema:  { type: 'object', properties: {} },
    }));

    return registry as ToolRegistry;
  }

  it('searches across all categories when category is omitted', async() => {
    const registry = makeRegistry();

    const tools = await registry.searchTools('get_workflows');

    expect(tools.map((tool: any) => tool.name)).toContain('get_workflows');
  });

  it('uses fuzzy fallback when no direct query match exists', async() => {
    const registry = makeRegistry();

    const tools = await registry.searchTools('get_executions');

    expect(tools.map((tool: any) => tool.name)).toContain('pg_execute');
  });
});
