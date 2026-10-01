import type { BaseThreadState } from '../nodes/Graph';

import { FULL_AGENT_TOOL_NAMES } from '../tools/fullAgentTools';

const ROUTINE_BROWSER_TOOLS = FULL_AGENT_TOOL_NAMES;

/** Browser authority comes only from the saved definition, never trigger text. */
export async function configureRoutineBrowser(
  state: BaseThreadState,
  definition: { browser?: boolean },
): Promise<void> {
  if (definition.browser !== true) return;
  const metadata = state.metadata as any;
  if (metadata.userVisibleBrowser === false) throw new Error('Routine browser requires a visible-browser-capable graph');
  const existing = metadata.allowedToolNames;
  // No agent is restricted: an existing tool list gains the browser instead of refusing it.
  const names = Array.isArray(existing)
    ? [...new Set([...existing, 'browser_controller'])]
    : ROUTINE_BROWSER_TOOLS;
  const { toolRegistry } = await import('../tools/registry');
  const schemas = await Promise.all(names.map((name: string) => toolRegistry.convertToolToLLM(name)));
  (state as any).llmTools = schemas;
  metadata.allowedToolNames = [...names];
  metadata.graphNativeBrowserController = true;
}
