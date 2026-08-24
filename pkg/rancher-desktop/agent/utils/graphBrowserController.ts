import type { BaseThreadState } from '../nodes/Graph';

export const GRAPH_BROWSER_TOOLS = [
  'tab', 'snapshot', 'text', 'form', 'screenshot',
  'click', 'fill', 'press_key', 'scroll', 'wait',
  'click_at', 'type_at', 'hover', 'eval_js',
] as const;

export type GraphBrowserTool = typeof GRAPH_BROWSER_TOOLS[number];

export function isGraphBrowserControllerEnabled(state?: BaseThreadState): boolean {
  const metadata = state?.metadata as any;
  const allowedToolNames = metadata?.allowedToolNames;

  return metadata?.graphNativeBrowserController === true &&
    metadata?.userVisibleBrowser !== false &&
    Array.isArray(allowedToolNames) &&
    allowedToolNames.includes('browser_controller');
}

export function graphBrowserControllerContext(state?: BaseThreadState): string {
  if (!isGraphBrowserControllerEnabled(state)) return '';
  return `<scheduled_browser_controller>
This scheduled Sulla graph has a graph-bound in-app Browser delegation tool:
\`mcp__sulla_native__browser_controller\`. The installed Codex Browser skill's
\`node_repl\` controller is host-app-specific and is not the supported controller
inside this Lima-launched scheduled graph. Read the installed Browser skill for
its safety/confirmation rules and Sulla's bundled \`tools/browser.md\` for this
controller's operations, then call \`browser_controller\` with a browser tool
name and args. Tabs are scoped to this graph thread; reuse the returned assetId.
Do not substitute a standalone Playwright server or bypass browser safety rules.
</scheduled_browser_controller>`;
}

export function browserAssetId(threadId: string, url: string): string {
  const scope = threadId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(-24) || 'graph';
  let target = 'page';
  try {
    const parsed = new URL(url);
    target = `${ parsed.hostname || parsed.protocol.replace(':', '') }${ parsed.pathname }`;
  } catch { /* retain page fallback */ }
  const slug = target.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'page';
  return `iab_${ scope }_${ slug }`;
}

export function normalizeGraphBrowserArgs(
  tool: GraphBrowserTool,
  args: Record<string, unknown>,
  threadId: string,
  lastAssetId?: string | null,
): Record<string, unknown> {
  const normalized = { ...args };

  if (tool === 'tab' && normalized.action !== 'remove') {
    // Never trust a caller-provided assetId. Derive ownership from the bound
    // graph session so a scheduled turn cannot attach to a user/chat tab.
    normalized.assetId = browserAssetId(threadId, String(normalized.url ?? ''));
  } else {
    if (!lastAssetId) {
      throw new Error('Browser controller has no graph-owned tab. Open one with tab/upsert first.');
    }
    // All follow-up operations, including tab/remove, are forced onto the
    // graph-owned tab. Global tab discovery is intentionally unsupported.
    normalized.assetId = lastAssetId;
  }
  return normalized;
}
