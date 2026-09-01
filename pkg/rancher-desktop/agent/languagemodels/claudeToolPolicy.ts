/**
 * Native-tool policy for every `claude` CLI spawn. Kept in its own module
 * (like codexSandboxPolicy) so tests can assert the policy without importing
 * the full ClaudeCodeService dependency graph.
 */

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
