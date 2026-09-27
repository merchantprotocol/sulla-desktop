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

/**
 * Additional native tools disabled for SUBCONSCIOUS (observer) spawns only.
 *
 * Subconscious agents (observation/identity writers + recalls, summarizer,
 * digester) are OBSERVERS — their entire job is to read the conversation and
 * record memory through their Sulla DB tools. They must never take real action
 * on the host. Their Sulla-registry toolset is already locked down to DB tools
 * via `allowedToolNames`, but that gate does NOT govern Claude Code's OWN
 * built-in tools. Spawned with --dangerously-skip-permissions, the CLI would
 * otherwise hand an observer full Read/Write/Edit/Bash/Grep/WebFetch access —
 * so a subconscious pass could (and did) start editing files instead of just
 * observing. Denylisting the native actor tools here makes acting structurally
 * impossible, matching the observer invariant (observers get DB tools only,
 * never filesystem/shell/source-control/browser/code-editing tools).
 *
 * Names include current + legacy aliases (e.g. KillShell/KillBash) so a rename
 * on either side is harmless — an unknown disallowed name is simply ignored.
 * (Task also appears in BASE_DISALLOWED_TOOLS now; the duplicate is harmless.)
 */
export const SUBCONSCIOUS_NATIVE_TOOL_DENYLIST = 'Read Write Edit MultiEdit NotebookEdit Bash BashOutput KillShell KillBash Glob Grep WebFetch WebSearch Task SlashCommand';

/**
 * Additional native tools disabled for WORKER sub-agent spawns (workflow
 * nodes, dispatcher workers, spawn_agent children) — sub-agents that keep
 * the actor tools but must not leave work running after they return.
 *
 * These tools arm work whose result arrives in a LATER turn: Monitor
 * callbacks, ScheduleWakeup, cron jobs, remote triggers, and native
 * multi-agent Workflow runs. A sub-agent's turn ends when it hands its
 * receipt to the parent, and background completions are deliberately never
 * routed back to sub-agents (wakeTargetFromState returns null — a wake would
 * start an orphan turn). So anything armed here is silently lost, and the
 * workflow node returns without the terminal result it promised (PR-conveyor
 * workers arming Monitor callbacks for CI instead of waiting in-process).
 * Workers must wait in-process, or return and let the parent own the wait.
 */
export const WORKER_DETACHED_WORK_DENYLIST = 'Monitor ScheduleWakeup CronCreate CronDelete CronList RemoteTrigger Workflow';

/**
 * Whether a spawn is a WORKER sub-agent: a sub-agent that does real work
 * (not an observer) and returns its result to a parent graph.
 */
export function isWorkerSpawn(metadata: Record<string, unknown> | null | undefined): boolean {
  return !!(metadata as any)?.isSubAgent && !isObserverSpawn(metadata);
}

/**
 * Full `--disallowedTools` value for a spawn, by role: primary chat gets the
 * base set, workers additionally lose detached-work tools, observers lose the
 * native actor tools.
 */
export function disallowedToolsFor(metadata: Record<string, unknown> | null | undefined): string {
  if (isObserverSpawn(metadata)) return `${ BASE_DISALLOWED_TOOLS } ${ SUBCONSCIOUS_NATIVE_TOOL_DENYLIST }`;
  if (isWorkerSpawn(metadata)) return `${ BASE_DISALLOWED_TOOLS } ${ WORKER_DETACHED_WORK_DENYLIST }`;

  return BASE_DISALLOWED_TOOLS;
}

/**
 * Whether a spawn is an OBSERVER that must lose the native actor tools.
 *
 * Keyed off the resolved model slot, not `isSubAgent` alone: workflow-node
 * agents and spawned workers are sub-agents too, but they do real work and
 * are stamped `modelSlot: 'primary'`. Treating every sub-agent as an observer
 * stripped Bash/Read from routine workers, so they could not run the sulla CLI
 * and died before intake (RippleCore PR-merge conveyor, cv2x). Unmarked
 * `isSubAgent` graphs still resolve to 'subconscious' and stay locked down.
 */
export function isObserverSpawn(metadata: Record<string, unknown> | null | undefined): boolean {
  return resolveModelSlot(metadata) === 'subconscious';
}
