// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Native-tool policy for every `claude` CLI spawn. Kept in its own module
 * (like codexSandboxPolicy) so tests can assert the policy without importing
 * the full ClaudeCodeService dependency graph.
 */

import { resolveModelSlot } from './modelSlotRouting';

/**
 * Base `--disallowedTools` set applied to EVERY claude spawn (primary and
 * subconscious): the built-in AskUserQuestion (routed through the sulla-native
 * MCP tool instead), Claude Code's built-in task/todo list, which competes
 * with Sulla Projects, and the native sub-agent spawn tools (Task + its Agent
 * rename). Sub-agent spawning must go through `sulla agents/spawn_agent`, whose
 * completions durably wake the parent graph — a natively spawned sub-agent
 * reports only to this (ephemeral) CLI process, so its finished work is
 * silently lost whenever the process exits before the report lands (zj21).
 * See ClaudeCodeService.buildSpawnArgs for the full rationale.
 */
export const BASE_DISALLOWED_TOOLS = 'AskUserQuestion TaskCreate TaskUpdate TaskList TaskGet TodoWrite TodoRead Task Agent';

/** Native agent-management controls are unavailable to every acting Claude spawn. */
export const ACTING_NATIVE_TOOL_DENYLIST = 'SendMessage TaskStop Workflow CronCreate CronDelete CronList RemoteTrigger';

/**
 * Native detached-work and direct-management controls are not available to
 * delegated workers or managers. The session-bound Sulla ask_user_question
 * MCP tool stays available: it records a persistent decision using the
 * caller's graph state and routes plain questions parent-first. Claude's own
 * AskUserQuestion remains disabled in BASE_DISALLOWED_TOOLS. Bash remains
 * available for synchronous commands, but run_in_background cannot be denied
 * independently by tool name.
 */
export const DELEGATED_NATIVE_TOOL_DENYLIST = 'Monitor TaskOutput TaskStop ScheduleWakeup CronCreate CronDelete CronList RemoteTrigger SendMessage Workflow';

/**
 * Additional native tools disabled for SUBCONSCIOUS memory-processing spawns.
 *
 * Subconscious agents (memory recall, V7 writer and summarizer) process memory
 * context and must never take real action on the host. Their Sulla-registry
 * toolset is already locked down via `allowedToolNames`, but that gate does NOT
 * govern Claude Code's OWN built-in tools. Spawned with
 * --dangerously-skip-permissions, the CLI would otherwise hand them full
 * Read/Write/Edit/Bash/Grep/WebFetch access. Denylisting the native actor tools
 * keeps memory processing separate from filesystem/shell/source-control/
 * browser/code-editing actions.
 *
 * Names include current + legacy aliases (e.g. KillShell/KillBash) so a rename
 * on either side is harmless — an unknown disallowed name is simply ignored.
 * (Task also appears in BASE_DISALLOWED_TOOLS now; the duplicate is harmless.)
 */
export const SUBCONSCIOUS_NATIVE_TOOL_DENYLIST = 'Read Write Edit MultiEdit NotebookEdit Bash BashOutput KillShell KillBash Glob Grep WebFetch WebSearch Task SlashCommand mcp__sulla-native__ask_user_question';

/** Support chats use only the graph-scoped MCP transport. */
export const SUPPORT_NATIVE_TOOL_DENYLIST = 'Bash Read Write Edit MultiEdit NotebookEdit BashOutput KillShell KillBash Glob Grep WebFetch WebSearch Task SlashCommand';

/**
 * Full `--disallowedTools` value for a spawn. Every acting agent — primary
 * chat, heartbeat, reviewers, workflow nodes, spawned sub-agents — gets the same base set. Only subconscious observers (memory
 * curators, never a swimlane actor) additionally lose the native actor tools.
 */
export class ClaudeToolPolicy {
  public disallowedToolsFor(metadata: Record<string, unknown> | null | undefined): string {
    if (this.isObserverSpawn(metadata)) return `${ BASE_DISALLOWED_TOOLS } ${ SUBCONSCIOUS_NATIVE_TOOL_DENYLIST }`;
    const acting = `${ BASE_DISALLOWED_TOOLS } ${ ACTING_NATIVE_TOOL_DENYLIST }`;
    if (this.isSupportSession(metadata)) return `${ acting } ${ SUPPORT_NATIVE_TOOL_DENYLIST }`;
    return this.isDelegatedSpawn(metadata) ? `${ acting } ${ DELEGATED_NATIVE_TOOL_DENYLIST }` : acting;
  }

  /** Support turns use only the gated support RPC MCP tool. */
  public isSupportSession(metadata: Record<string, unknown> | null | undefined): boolean {
    return typeof metadata?.supportSessionId === 'string' && metadata.supportSessionId.length > 0;
  }

  /** Delegated workers and delegated managers share the Sulla-only controls. */
  public isDelegatedSpawn(metadata: Record<string, unknown> | null | undefined): boolean {
    return metadata?.isSubAgent === true;
  }

  /** Observers lose native actor tools; acting primary agents retain Bash/Read/etc. */
  public isObserverSpawn(metadata: Record<string, unknown> | null | undefined): boolean {
    return resolveModelSlot(metadata) === 'subconscious';
  }
}
