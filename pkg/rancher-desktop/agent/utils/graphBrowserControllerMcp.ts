import { z } from 'zod';

import {
  GRAPH_BROWSER_TOOLS,
  isGraphBrowserControllerEnabled,
  type GraphBrowserTool,
} from './graphBrowserController';
import { toolRegistry } from '../tools/registry';

import type { BaseThreadState } from '../nodes/Graph';

interface McpToolRegistrar {
  registerTool(
    name: string,
    config: Record<string, unknown>,
    handler: (input: { tool: GraphBrowserTool; args: Record<string, unknown> }) => Promise<{
      content: { type: 'text'; text: string }[];
      isError: boolean;
    }>,
  ): unknown;
}

/** Register the scheduled-graph Browser bridge only when the bound graph owns the capability. */
export function registerGraphBrowserControllerMcp(server: unknown, state: BaseThreadState): boolean {
  if (!isGraphBrowserControllerEnabled(state)) return false;

  // The SDK's registerTool signature recursively infers its Zod schema and
  // exceeds TypeScript's depth limit in MCPServerHost. Keep that generic
  // boundary here while retaining concrete request/result types internally.
  const registrar = server as McpToolRegistrar;
  registrar.registerTool(
    'browser_controller',
    {
      description: [
        'Graph-bound controller for Sulla Desktop\'s in-app Browser.',
        'Use this in scheduled Sulla graphs after reading the installed Browser skill safety rules and the bundled tools/browser.md operation guide.',
        'Pass one supported browser operation and its arguments. Every operation is forced onto the tab owned by the calling graph thread.',
        'This is the supported scheduled-graph delegation path; do not substitute standalone Playwright or an external browser.',
      ].join(' '),
      inputSchema: {
        tool: z.enum(GRAPH_BROWSER_TOOLS).describe('Browser operation to execute.'),
        args: z.record(z.unknown()).default({}).describe('Arguments documented for the selected Sulla browser operation.'),
      },
    },
    async({ tool, args }) => {
      const worker = await toolRegistry.createTool('browser_controller');
      const result = await worker.invoke({ tool, args }, state);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        isError: !result.success,
      };
    },
  );

  return true;
}
