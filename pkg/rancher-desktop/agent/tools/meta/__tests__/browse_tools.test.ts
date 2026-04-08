import { describe, expect, it, afterEach } from '@jest/globals';

import { BrowseToolsWorker } from '../browse_tools';
import { toolRegistry } from '../../registry';

// Snapshot originals so we can restore after each test
const originalGetCategories = toolRegistry.getCategories.bind(toolRegistry);
const originalGetCategoriesWithDescriptions = toolRegistry.getCategoriesWithDescriptions.bind(toolRegistry);
const originalGetToolNamesForCategory = toolRegistry.getToolNamesForCategory.bind(toolRegistry);
const originalGetToolDescription = toolRegistry.getToolDescription.bind(toolRegistry);
const originalGetSchemaDef = toolRegistry.getSchemaDef.bind(toolRegistry);

function createWorker(): BrowseToolsWorker {
  const worker = new BrowseToolsWorker();
  worker.name = 'browse_tools';
  worker.description = 'Search available tools by category or keyword.';
  worker.schemaDef = {
    category: { type: 'string', optional: true, description: 'Tool category to list.' },
    query:    { type: 'string', optional: true, description: 'Keyword to search.' },
  };
  return worker;
}

describe('browse_tools output format', () => {
  afterEach(() => {
    (toolRegistry as any).getCategories = originalGetCategories;
    (toolRegistry as any).getCategoriesWithDescriptions = originalGetCategoriesWithDescriptions;
    (toolRegistry as any).getToolNamesForCategory = originalGetToolNamesForCategory;
    (toolRegistry as any).getToolDescription = originalGetToolDescription;
    (toolRegistry as any).getSchemaDef = originalGetSchemaDef;
  });

  function mockRegistry(tools: Record<string, { description: string; category: string; schemaDef: Record<string, any> }>) {
    const categories = [...new Set(Object.values(tools).map(t => t.category))];

    (toolRegistry as any).getCategories = () => categories;
    (toolRegistry as any).getCategoriesWithDescriptions = () =>
      categories.map(c => ({ category: c, description: `${ c } tools.` }));
    (toolRegistry as any).getToolNamesForCategory = (cat: string) =>
      Object.entries(tools).filter(([, t]) => t.category === cat).map(([name]) => name);
    (toolRegistry as any).getToolDescription = (name: string) =>
      tools[name]?.description || '';
    (toolRegistry as any).getSchemaDef = (name: string) =>
      tools[name]?.schemaDef || undefined;
  }

  it('returns sulla CLI format with params for a category', async() => {
    mockRegistry({
      docker_ps: {
        description: 'List Docker containers.',
        category:    'docker',
        schemaDef:   { all: { type: 'boolean', optional: true, description: 'Include stopped.' } },
      },
      docker_run: {
        description: 'Run a Docker container.',
        category:    'docker',
        schemaDef:   {
          image: { type: 'string', description: 'Docker image to run' },
          name:  { type: 'string', optional: true, description: 'Container name' },
        },
      },
    });

    const result = await createWorker().invoke({ category: 'docker' });

    expect(result.success).toBe(true);
    const response = result.result as string;

    // Category header
    expect(response).toContain('## docker');

    // CLI format
    expect(response).toContain("sulla docker/ps '{}'");
    expect(response).toContain('sulla docker/run \'{"image":"<image>"}\'');

    // Descriptions
    expect(response).toContain('List Docker containers.');
    expect(response).toContain('Run a Docker container.');

    // Params
    expect(response).toContain('Params: all (optional, boolean)');
    expect(response).toContain('image (required, string)');
    expect(response).toContain('name (optional, string)');

    // Exec example for tool with required params (non-meta category)
    expect(response).toContain('Example: sulla meta/exec');
  });

  it('searches across categories by query', async() => {
    mockRegistry({
      git_status: {
        description: 'Show working tree status.',
        category:    'github',
        schemaDef:   { absolutePath: { type: 'string', description: 'Path to repo' } },
      },
      docker_ps: {
        description: 'List Docker containers.',
        category:    'docker',
        schemaDef:   {},
      },
    });

    const result = await createWorker().invoke({ query: 'git' });

    expect(result.success).toBe(true);
    const response = result.result as string;

    expect(response).toContain('Found 1 tools matching "git"');
    expect(response).toContain('sulla github/git_status');
    expect(response).not.toContain('docker');
  });

  it('lists categories when called with no args', async() => {
    mockRegistry({
      docker_ps:      { description: 'List containers.', category: 'docker', schemaDef: {} },
      slack_send:     { description: 'Send message.', category: 'slack', schemaDef: {} },
    });

    const result = await createWorker().invoke({});

    expect(result.success).toBe(true);
    const response = result.result as string;

    expect(response).toContain('## Available Tool Categories');
    expect(response).toContain('docker');
    expect(response).toContain('slack');
    expect(response).toContain('Call browse_tools with a category or query');
  });

  it('returns error for invalid category', async() => {
    mockRegistry({
      docker_ps: { description: 'List containers.', category: 'docker', schemaDef: {} },
    });

    const result = await createWorker().invoke({ category: 'nonexistent' });

    expect(result.success).toBe(false);
    expect(result.result as string).toContain('Invalid category "nonexistent"');
    expect(result.result as string).toContain('docker');
  });

  it('returns error when no tools match query', async() => {
    mockRegistry({
      docker_ps: { description: 'List containers.', category: 'docker', schemaDef: {} },
    });

    const result = await createWorker().invoke({ query: 'zzzznotfound' });

    expect(result.success).toBe(false);
    expect(result.result as string).toContain('No tools found');
    expect(result.result as string).toContain('Available categories: docker');
  });

  it('does not include exec example for meta tools', async() => {
    mockRegistry({
      exec: {
        description: 'Execute a shell command.',
        category:    'meta',
        schemaDef:   { command: { type: 'string', description: 'Shell command' } },
      },
    });

    const result = await createWorker().invoke({ category: 'meta' });

    expect(result.success).toBe(true);
    const response = result.result as string;

    expect(response).toContain("sulla meta/exec '{\"command\":\"<command>\"}");
    // Meta tools should NOT have a nested exec example (would be redundant)
    expect(response).not.toContain('Example:');
  });
});
