import { shouldWakeWorkflowConversation } from '../../workflow/workflowContinuation';

describe('workflow sub-agent continuation routing', () => {
  it('re-enters a running workflow even when chat metadata is waiting', () => {
    expect(shouldWakeWorkflowConversation({
      waitingForUser: true,
      activeWorkflow: { status: 'running' },
    })).toBe(false);
  });

  it('wakes an idle chat when no workflow is running', () => {
    expect(shouldWakeWorkflowConversation({ waitingForUser: true })).toBe(true);
    expect(shouldWakeWorkflowConversation({ cycleComplete: true })).toBe(true);
  });

  it('does not wake when neither workflow nor chat needs continuation', () => {
    expect(shouldWakeWorkflowConversation({ activeWorkflow: { status: 'completed' } })).toBe(false);
    expect(shouldWakeWorkflowConversation(undefined)).toBe(false);
  });
});
