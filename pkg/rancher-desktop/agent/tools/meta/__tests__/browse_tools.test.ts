import { describe, expect, it, afterEach } from '@jest/globals';

import { BrowseToolsWorker, browseToolsRegistration } from '../browse_tools';
import { toolRegistry } from '../../registry';

describe('browse_tools output details', () => {
  const originalSearchTools = toolRegistry.searchTools.bind(toolRegistry);
  const originalGetCategories = toolRegistry.getCategories.bind(toolRegistry);

  afterEach(() => {
    (toolRegistry as any).searchTools = originalSearchTools;
    (toolRegistry as any).getCategories = originalGetCategories;
  });

  it('returns tool name, description, and signature for each found tool', async() => {
    (toolRegistry as any).searchTools = async() => ([
      {
        name:        'slack_post_message',
        description: 'Post a message to Slack',
        jsonSchema:  {
          type:       'object',
          properties: {
            channel: { type: 'string' },
            text:    { type: 'string' },
          },
          required: ['channel', 'text'],
        },
      },
      {
        name:        'slack_react',
        description: 'React to a message in Slack',
        schemaDef:   {
          channel:   { type: 'string' },
          timestamp: { type: 'string' },
          emoji:     { type: 'string' },
        },
      },
    ]);

    const worker = new BrowseToolsWorker();
    worker.name = browseToolsRegistration.name;
    worker.description = browseToolsRegistration.description;
    worker.schemaDef = browseToolsRegistration.schemaDef;

    const result = await worker.invoke({ category: 'slack' });

    expect(result.success).toBe(true);
    const response = result.result as string;
    expect(response).toContain('Found 2 tools in category "slack"');
    expect(response).toContain('"name": "slack_post_message"');
    expect(response).toContain('"description": "Post a message to Slack"');
    expect(response).toContain('"required": [');
    expect(response).toContain('"name": "slack_react"');
  });

  it('accepts meta category and returns meta tool details', async() => {
    (toolRegistry as any).searchTools = async() => ([
      {
        name:        'browse_tools',
        description: 'List available tools by category or search term.',
        jsonSchema:  {
          type:       'object',
          properties: {
            category: { type: 'string' },
          },
          required: [],
        },
      },
    ]);

    const worker = new BrowseToolsWorker();
    worker.name = browseToolsRegistration.name;
    worker.description = browseToolsRegistration.description;
    worker.schemaDef = browseToolsRegistration.schemaDef;

    const result = await worker.invoke({ category: 'meta' });

    expect(result.success).toBe(true);
    const response = result.result as string;
    expect(response).toContain('Found 1 tools in category "meta"');
    expect(response).toContain('"name": "browse_tools"');
    expect(response).toContain('"description": "List available tools by category or search term."');
  });

  it('accepts workspace category and returns workspace tool details', async() => {
    (toolRegistry as any).searchTools = async() => ([
      {
        name:        'workspace_list',
        description: 'List available workspaces',
        jsonSchema:  {
          type:       'object',
          properties: {},
          required:   [],
        },
      },
    ]);

    const worker = new BrowseToolsWorker();
    worker.name = browseToolsRegistration.name;
    worker.description = browseToolsRegistration.description;
    worker.schemaDef = browseToolsRegistration.schemaDef;

    const result = await worker.invoke({ category: 'workspace' });

    expect(result.success).toBe(true);
    const response = result.result as string;
    expect(response).toContain('Found 1 tools in category "workspace"');
    expect(response).toContain('"name": "workspace_list"');
    expect(response).toContain('"description": "List available workspaces"');
  });

  it('keeps no-tools response behavior intact', async() => {
    (toolRegistry as any).searchTools = async() => ([]);
    (toolRegistry as any).getCategories = () => ['slack', 'n8n', 'pg'];

    const worker = new BrowseToolsWorker();
    worker.name = browseToolsRegistration.name;
    worker.description = browseToolsRegistration.description;
    worker.schemaDef = browseToolsRegistration.schemaDef;

    const result = await worker.invoke({ category: 'slack' });

    expect(result.success).toBe(false);
    expect(result.result as string).toContain('No tools found in category "slack"');
    expect(result.result as string).toContain('Available categories: slack, n8n, pg');
  });
});
