/**
 * Execution policy for locked core routines.
 *
 * Their definitions are bundled, hashed, and re-seeded at boot, so the
 * configured agent task is already the trusted instruction. It must not be
 * replaced by an orchestrator-generated paraphrase. They also run unattended;
 * a blocked child is a terminal run failure, not a chat pause.
 */

export function resolveAgentTaskForDispatch(
  isLockedCoreRoutine: boolean,
  configuredTask: string,
  formulatedTask: string,
): string {
  return isLockedCoreRoutine ? configuredTask.trim() : formulatedTask;
}

export function lockedCoreBlockedError(
  isLockedCoreRoutine: boolean,
  nodeLabel: string,
  blocker: string,
): string | null {
  if (!isLockedCoreRoutine) return null;

  return `Locked core routine node "${ nodeLabel }" blocked: ${ blocker }`;
}

/**
 * Opt-in inheritance for security-sensitive workflow children. Normal agent
 * nodes retain their configured persona tools. A node that sets
 * inheritParentToolPolicy receives the parent's already-resolved tool list and
 * native-provider sandbox flag, preventing a child graph from regaining write
 * tools that the parent deliberately removed.
 */
export function inheritSubAgentToolPolicy(
  parentState: any,
  subState: any,
  config: Record<string, unknown>,
): void {
  if (config.inheritParentToolPolicy !== true) return;
  const parentMeta = parentState?.metadata ?? {};
  subState.metadata ??= {};
  if (Array.isArray(parentMeta.allowedToolNames)) {
    subState.metadata.allowedToolNames = [...parentMeta.allowedToolNames];
  }
  if (Array.isArray(parentState?.llmTools)) {
    subState.llmTools = [...parentState.llmTools];
  }
  if (parentMeta.verifierReadOnly === true) {
    subState.metadata.verifierReadOnly = true;
  }
}
