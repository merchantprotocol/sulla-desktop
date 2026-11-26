// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * graphToolSurface — the graph-stamped tool surface, projected to CLI providers.
 *
 * The graph system is the single authority on which tools an agent node may
 * use: the graph runtime (and subconscious/observer plumbing) stamps
 * state.metadata.allowedToolNames, and inheritSubAgentToolPolicy propagates it
 * to sub-nodes. API-driven providers honor that surface because the graph
 * loop executes their tool calls. CLI-driven providers (Claude Code, Codex,
 * or any future CLI model) bring their own harness and would otherwise bypass
 * it. A surface that includes `exec` carries full Sulla catalog authority
 * (toolSessionPolicy), which dispatched workers and reviewers both get.
 *
 * This module closes that gap provider-neutrally: any session whose graph
 * state carries an explicit allowedToolNames gets a `sulla_tool` MCP tool
 * that dispatches in-process to the same ToolRegistry worker the graph loop
 * would use, enforcing exactly that allowlist. The provider never decides the
 * tool surface — the graph does, the same way it does for subconscious
 * observer agents.
 */

import { sessionAllowsTool } from './toolSessionPolicy';
import type { AgentAwarenessPolicy } from '@pkg/agent/services/AgentAwarenessPolicy';

import type { ClerkCaller } from '@pkg/agent/integrations/clerk/ClerkClient';
import type { BaseThreadState } from '@pkg/agent/nodes/Graph';
import { containerRuntimeForExecution, withAgentContainerRuntime } from '@pkg/agent/services/AgentContainerRuntimeRegistry';
import { ToolSessionChatTransport } from '@pkg/agent/tools/ToolSessionChatTransport';
import type { ToolExecutionContext } from '@pkg/agent/tools/executionContext';
import type { ToolExecutionTarget } from '@pkg/agent/tools/executionTargets';

export interface GraphToolCallResult {
  // Index signature required for assignability to the MCP SDK's CallToolResult.
  [key: string]: unknown;
  content:       { type: 'text'; text: string }[];
  isError?:      boolean;
}

interface ToolWorker {
  name?:             string;
  metadata?:         { category?: unknown };
  executionContext?: ToolExecutionContext;
  bindClerkCaller?(caller: ClerkCaller): void;
  sendChatMessage?:  (content: string, kind?: string, extras?: Record<string, unknown>) => Promise<boolean>;
  call(args: Record<string, unknown>): Promise<{ success: boolean; result?: unknown; error?: unknown }>;
  invoke?(args: Record<string, unknown>, state: BaseThreadState): Promise<{ success: boolean; result?: unknown; error?: unknown }>;
}

export type ToolResolver = (name: string) => Promise<ToolWorker>;

export interface GraphToolExecutionOptions {
  state:             BaseThreadState;
  /** Present only for container runtimes; in-VM sessions run with the bound state alone. */
  executionContext?: ToolExecutionContext;
  resolveClerkCaller(name: string, signal: AbortSignal): Promise<ClerkCaller>;
  executionTarget(name: string): ToolExecutionTarget | undefined;
}

/**
 * Resolve the graph-stamped tool surface for a session. Returns the
 * allowlist when the graph explicitly restricted this agent's tools
 * (non-empty allowedToolNames), null for unrestricted sessions — those
 * already have the full CLI catalog and need no projection.
 */
export function resolveGraphToolSurface(metadata: unknown, awarenessPolicy: AgentAwarenessPolicy): string[] | null {
  const meta = (metadata ?? {}) as Record<string, unknown>;
  const allowed = meta.allowedToolNames;
  if (!Array.isArray(allowed) || allowed.length === 0) return null;
  return awarenessPolicy.filterToolNames(
    allowed.filter((name): name is string => typeof name === 'string'),
    { agent_awareness: meta.agentAwareness as boolean | undefined },
  );
}

/**
 * Build the sulla_tool handler: enforce the graph-stamped allowlist, then
 * dispatch in-process to the ToolRegistry worker and map its result to MCP
 * content.
 */
export function buildGraphToolHandler(
  allowedTools: string[],
  getTool: ToolResolver,
  execution: GraphToolExecutionOptions,
  awarenessPolicy: AgentAwarenessPolicy,
) {
  const chatTransport = new ToolSessionChatTransport();
  return async({ tool, args }: { tool: string; args?: Record<string, unknown> }, extra: { signal: AbortSignal }): Promise<GraphToolCallResult> => {
    // `exec` in the surface means full Sulla catalog authority (same rule as
    // the CLI session gate), so dispatched workers can reach github/*,
    // files/*, etc. here too — sandboxed CLI providers have no other path.
    if (!awarenessPolicy.allowsTool(execution.state.metadata, tool)) {
      return { content: [{ type: 'text', text: `sulla_tool: '${ tool }' is not available to this agent.` }], isError: true };
    }
    if (!sessionAllowsTool(allowedTools, tool, execution.state.metadata, awarenessPolicy)) {
      return {
        content: [{ type: 'text', text: `sulla_tool: "${ tool }" is not in this agent's graph-stamped tool surface. Allowed: ${ allowedTools.join(', ') }` }],
        isError: true,
      };
    }
    try {
      const worker = await getTool(tool);
      let result;
      if (execution) {
        if (worker.metadata?.category === 'clerk') {
          if (!worker.bindClerkCaller || worker.name !== tool) throw new Error('Clerk worker cannot verify its caller.');
          const graphSignal = execution.state.metadata.options?.abort?.signal;
          const signal = graphSignal ? AbortSignal.any([graphSignal, extra.signal]) : extra.signal;
          worker.bindClerkCaller(await execution.resolveClerkCaller(tool, signal));
        } else if (execution.executionContext) worker.executionContext = execution.executionContext;
        chatTransport.attach(worker, execution.state);
        const runtime = execution.executionContext
          ? containerRuntimeForExecution(execution.executionContext, execution.executionTarget(tool))
          : undefined;
        const invoke = () => worker.invoke
          ? worker.invoke(args ?? {}, execution.state)
          : worker.call(args ?? {});
        result = runtime
          ? await withAgentContainerRuntime(runtime, invoke)
          : await invoke();
      } else {
        result = await worker.call(args ?? {});
      }
      return {
        content: [{ type: 'text', text: typeof result.result === 'string' ? result.result : JSON.stringify(result.result ?? result.error ?? '') }],
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
