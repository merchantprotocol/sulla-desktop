/**
 * graphToolSurface — the graph-stamped tool surface, projected to CLI providers.
 *
 * The graph system is the single authority on which tools an agent node may
 * use: the dispatcher (and subconscious/observer plumbing) stamps
 * state.metadata.allowedToolNames, and inheritSubAgentToolPolicy propagates it
 * to sub-nodes. API-driven providers honor that surface because the graph
 * loop executes their tool calls. CLI-driven providers (Claude Code, Codex,
 * or any future CLI model) bring their own harness and would otherwise bypass
 * it — verifier runs additionally execute under a network-denying sandbox, so
 * even shelling to the `sulla` CLI fails (curl exit 7 before it reaches the
 * tools bridge).
 *
 * This module closes that gap provider-neutrally: any session whose graph
 * state carries an explicit allowedToolNames gets a `sulla_tool` MCP tool
 * that dispatches in-process to the same ToolRegistry worker the graph loop
 * would use, enforcing exactly that allowlist. The provider never decides the
 * tool surface — the graph does, the same way it does for subconscious
 * observer agents.
 */

export interface GraphToolCallResult {
  // Index signature required for assignability to the MCP SDK's CallToolResult.
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

interface ToolWorker {
  call(args: Record<string, unknown>): Promise<{ success: boolean; result?: unknown; error?: unknown }>;
}

export type ToolResolver = (name: string) => Promise<ToolWorker>;

/**
 * Resolve the graph-stamped tool surface for a session. Returns the
 * allowlist when the graph explicitly restricted this agent's tools
 * (non-empty allowedToolNames), null for unrestricted sessions — those
 * already have the full CLI catalog and need no projection.
 */
export function resolveGraphToolSurface(metadata: unknown): string[] | null {
  const meta = (metadata ?? {}) as Record<string, unknown>;
  const allowed = meta.allowedToolNames;
  if (!Array.isArray(allowed) || allowed.length === 0) return null;
  return allowed.filter((name): name is string => typeof name === 'string');
}

/**
 * Build the sulla_tool handler: enforce the graph-stamped allowlist, then
 * dispatch in-process to the ToolRegistry worker and map its result to MCP
 * content.
 */
export function buildGraphToolHandler(allowedTools: string[], getTool: ToolResolver) {
  return async ({ tool, args }: { tool: string; args?: Record<string, unknown> }): Promise<GraphToolCallResult> => {
    if (!allowedTools.includes(tool)) {
      return {
        content: [{ type: 'text', text: `sulla_tool: "${ tool }" is not in this agent's graph-stamped tool surface. Allowed: ${ allowedTools.join(', ') }` }],
        isError: true,
      };
    }
    try {
      const worker = await getTool(tool);
      const result = await worker.call(args ?? {});
      return {
        content: [{ type: 'text', text: String(result.result ?? result.error ?? '') }],
        isError: !result.success,
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `sulla_tool: ${ tool } failed: ${ (err as Error)?.message ?? err }` }],
        isError: true,
      };
    }
  };
}
