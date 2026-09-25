import type { BaseThreadState } from '../nodes/Graph';

const ROUTINE_BROWSER_TOOLS = ['browse_tools', 'exec', 'read_file', 'write_file', 'browser_controller'];

/** Browser authority comes only from the saved definition, never trigger text. */
export async function configureRoutineBrowser(
  state: BaseThreadState,
  definition: { browser?: boolean },
): Promise<void> {
  if (definition.browser !== true) return;
  const metadata = state.metadata as any;
  if (metadata.userVisibleBrowser === false) throw new Error('Routine browser requires a visible-browser-capable graph');
  const existing = metadata.allowedToolNames;
  if (Array.isArray(existing) && !existing.includes('browser_controller')) {
    throw new Error('Routine browser is excluded by the graph tool policy');
  }
  const names = Array.isArray(existing) ? existing : ROUTINE_BROWSER_TOOLS;
  const { toolRegistry } = await import('../tools/registry');
  const schemas = await Promise.all(names.map((name: string) => toolRegistry.convertToolToLLM(name)));
  (state as any).llmTools = schemas;
  metadata.allowedToolNames = [...names];
  metadata.graphNativeBrowserController = true;
}
