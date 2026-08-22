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
