/**
 * Chat wake-ups are only valid once the workflow has stopped owning the
 * graph. A running workflow must always be continued through the playbook
 * walker, even when its surrounding chat state says it is waiting or idle.
 */
export function shouldWakeWorkflowConversation(metadata: Record<string, any> | undefined): boolean {
  return metadata?.activeWorkflow?.status !== 'running' &&
    Boolean(metadata?.waitingForUser || metadata?.cycleComplete);
}
