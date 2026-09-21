import { describe, expect, it } from '@jest/globals';
import { workflowTerminalResult } from '../WorkflowTerminalResult';

describe('workflow terminal receipts', () => {
  it('does not turn a yielded, suspended or absent workflow into success', () => {
    for (const status of ['running', 'suspended', undefined]) {
      expect(workflowTerminalResult({ activeWorkflow: { executionId: 'run', status } }, 'run')).toBeNull();
    }
  });
  it('preserves failure after the active workflow has been cleared', () => {
    expect(workflowTerminalResult({ lastCompletedWorkflow: {
      executionId: 'run', outcome: 'failed', error: 'review failed', nodeResults: [],
    } }, 'run')).toMatchObject({ status: 'failed', error: 'review failed' });
  });
  it('rejects another execution and retains the matching structured transition', () => {
    const metadata = { lastCompletedWorkflow: {
      executionId: 'run', outcome: 'completed', nodeResults: [
        { result: '{"transition":{"mode":"next"},"custody":{"sha":"abc"}}' },
        { result: 'Finished.' },
      ],
    } };
    expect(workflowTerminalResult(metadata, 'stale')).toBeNull();
    expect(workflowTerminalResult(metadata, 'run')).toMatchObject({
      status: 'completed', outcome: { transition: { mode: 'next' }, custody: { sha: 'abc' } },
    });
  });
});
