// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Decides where the AgentGraph goes after the `agent` node: end the turn or
 * loop back to the agent. Reads `metadata.agent.status` written by AgentNode.
 *
 * `metadata.agent` may be missing (a thread whose agent config resolved to
 * nothing, e.g. the default identity or a disabled definition). Reading it is
 * guarded, and so is every write: a bare `metadata.agent.status = 'done'`
 * threw "Cannot set properties of undefined (setting 'status')" and failed the
 * whole chat turn.
 */
export class AgentGraphRouter {
  route(state: { metadata: any }): 'end' | 'agent' {
    const metadata = state.metadata;

    // An activated workflow takes over orchestration, except during a playbook
    // reentry where the agent must finish its multi-turn tool chain first.
    const isPlaybookReentry = !!metadata._isPlaybookReentry;
    if (metadata.activeWorkflow?.status === 'running' && !isPlaybookReentry) {
      console.log('[AgentGraph] Workflow activated — pausing agent for workflow orchestration');
      return 'end';
    }

    const agentMeta = metadata.agent || {};
    const agentStatus = String(agentMeta.status || '').trim().toLowerCase();

    if (agentStatus === 'done') {
      console.log('[AgentGraph] Agent reported DONE - ending');
      return 'end';
    }

    if (agentStatus === 'blocked') {
      console.log('[AgentGraph] Agent reported BLOCKED - ending');
      return 'end';
    }

    // Tool calls without a wrapper mean the model expects to see the tool
    // results: an implicit CONTINUE. The flag is consumed so it can't stay
    // stuck true and spin this branch with no LLM activity (normalizedChat's
    // assistant-already-responded short-circuit skips its reset).
    if (agentStatus === 'in_progress' && metadata.hadToolCalls) {
      const newLoopCount = (metadata.agentLoopCount || 0) + 1;
      metadata.agentLoopCount = newLoopCount;
      metadata.hadToolCalls = false;
      console.log(`[AgentGraph] Agent made tool calls without wrapper — implicit continue (cycle ${ newLoopCount })`);
      return 'agent';
    }

    // Default to DONE: only an explicit <AGENT_CONTINUE> keeps the loop going.
    if (agentStatus !== 'continue') {
      console.log(`[AgentGraph] Agent status '${ agentStatus || 'unknown' }' is not CONTINUE — defaulting to DONE`);
      metadata.agent = { ...(metadata.agent || {}), status: 'done' };
      metadata.cycleComplete = true;
      return 'end';
    }

    const newLoopCount = (metadata.agentLoopCount || 0) + 1;
    metadata.agentLoopCount = newLoopCount;
    console.log(`[AgentGraph] Agent cycle ${ newLoopCount } - continuing`);
    return 'agent';
  }
}
