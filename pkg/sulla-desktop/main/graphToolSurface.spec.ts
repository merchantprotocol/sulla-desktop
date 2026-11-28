// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';

import { AgentAwarenessPolicy } from '@pkg/agent/services/AgentAwarenessPolicy';
import { buildGraphToolHandler, resolveGraphToolSurface } from './graphToolSurface';

describe('graph-bound question tool surface', () => {
  it('dispatches the persistent question action with the delegated child graph state when exec grants the catalog', async() => {
    // risk: identity integrity — a CLI/MCP catalog call must keep the child thread that DecisionRouteResolver uses to find its parent.
    const state = { metadata: { threadId: 'child-thread', wsChannel: 'child-channel', isSubAgent: true, allowedToolNames: ['exec'] } } as any;
    const allowed = resolveGraphToolSurface(state.metadata, new AgentAwarenessPolicy())!;
    const worker = {
      name: 'ask_user_question', metadata: { category: 'meta' },
      invoke: vi.fn(async(_args: unknown, invocationState: unknown) => ({ success: true, result: (invocationState as any).metadata.threadId })),
      call: vi.fn(),
    };
    const handler = buildGraphToolHandler(allowed, async() => worker as any,
      { state, executionTarget: () => undefined }, new AgentAwarenessPolicy());

    const result = await handler({ tool: 'ask_user_question', args: { questions: [] } });

    expect(result).toMatchObject({ content: [{ text: 'child-thread' }] });
    expect(worker.invoke).toHaveBeenCalledWith({ questions: [] }, state);
  });

  it('refuses the question action when a delegated agent has only a narrow non-exec allowlist', async() => {
    // risk: permissions — making parent decisions reachable must not grant a narrow worker the full question capability.
    const state = { metadata: { threadId: 'restricted-child', isSubAgent: true, allowedToolNames: ['files/search'] } } as any;
    const allowed = resolveGraphToolSurface(state.metadata, new AgentAwarenessPolicy())!;
    const getTool = vi.fn();
    const handler = buildGraphToolHandler(allowed, getTool as any,
      { state, executionTarget: () => undefined }, new AgentAwarenessPolicy());

    const result = await handler({ tool: 'ask_user_question', args: { questions: [] } });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not in this agent\'s graph-stamped tool surface');
    expect(getTool).not.toHaveBeenCalled();
  });
});
