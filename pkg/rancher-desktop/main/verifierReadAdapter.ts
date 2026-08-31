/**
 * verifierReadAdapter — host-side read bridge for sandboxed verifier runs.
 *
 * Verifier runs (verifierReadOnly) execute CLI models under a network-denying
 * sandbox (codex --sandbox read-only inside the Lima VM), so shelling out to
 * the `sulla` CLI fails with curl exit 7 before it can reach the tools
 * bridge. The read_adapter MCP tool built from this module runs in the host
 * process — outside that sandbox — and dispatches straight to the same
 * ToolRegistry worker the CLI would hit. The allowlist is the
 * dispatcher-stamped allowedToolNames (the read-only verification adapter
 * catalog), so the sandbox's write guarantee is preserved: only cataloged
 * read tools are reachable, and only for sessions the dispatcher marked as
 * verifiers.
 */

export interface ReadAdapterToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

interface ToolWorker {
  call(args: Record<string, unknown>): Promise<{ success: boolean; result?: unknown; error?: unknown }>;
}

export type ToolResolver = (name: string) => Promise<ToolWorker>;

/**
 * Decide whether a session should receive the read_adapter tool. Returns the
 * allowlist when the session is a dispatcher-marked verifier with a
 * non-empty allowedToolNames, null otherwise.
 */
export function resolveVerifierReadTools(metadata: unknown): string[] | null {
  const meta = (metadata ?? {}) as Record<string, unknown>;
  if (meta.verifierReadOnly !== true) return null;
  const allowed = meta.allowedToolNames;
  if (!Array.isArray(allowed) || allowed.length === 0) return null;
  return allowed.filter((name): name is string => typeof name === 'string');
}

/**
 * Build the read_adapter handler: enforce the allowlist, then dispatch
 * in-process to the ToolRegistry worker and map its result to MCP content.
 */
export function buildReadAdapterHandler(allowedTools: string[], getTool: ToolResolver) {
  return async ({ tool, args }: { tool: string; args?: Record<string, unknown> }): Promise<ReadAdapterToolResult> => {
    if (!allowedTools.includes(tool)) {
      return {
        content: [{ type: 'text', text: `read_adapter: "${ tool }" is not in the read-only adapter catalog for this review. Allowed: ${ allowedTools.join(', ') }` }],
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
        content: [{ type: 'text', text: `read_adapter: ${ tool } failed: ${ (err as Error)?.message ?? err }` }],
        isError: true,
      };
    }
  };
}
