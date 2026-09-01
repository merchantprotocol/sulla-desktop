/** Codex CLI sandbox flags for normal actors versus read-only verifiers. */
export function codexSandboxArgs(readOnly: boolean): string[] {
  return readOnly
    ? ['--sandbox', 'read-only']
    : ['--dangerously-bypass-approvals-and-sandbox'];
}

/**
 * Codex feature pins applied to EVERY graph-provisioned codex spawn:
 * provider-native sub-agent spawning is structurally disallowed (zj21).
 *
 * codex-cli 0.151.0 ships the `multi_agent` feature stable AND enabled by
 * default, so without an explicit pin every graph session carries a native
 * spawn surface. Natively spawned sub-agents report completion to the
 * (ephemeral) parent CLI process rather than the Sulla graph — finished work
 * is silently lost when that process exits. Delegation must go through
 * `sulla agents/spawn_agent`, whose results durably wake the parent graph.
 *
 * Pinned as `-c` overrides so a user-level ~/.codex/config.toml can never
 * re-enable them for graph sessions; unknown keys are ignored by older CLIs.
 */
export const CODEX_NATIVE_SPAWN_FEATURE_PINS = [
  'features.multi_agent=false',
  'features.multi_agent_v2=false',
];
