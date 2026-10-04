import { describe, expect, it } from '@jest/globals';

import { REVIEW_PROJECT_ARTIFACT_DEFINITION } from '../../routines/core/reviewProjectArtifact';
import { completeSubAgent, createPlaybookState, processNextStep } from '../WorkflowPlaybook';

describe('protected review workflow engine', () => {
  it('runs classification, serial independent reviews, synthesis, and response end to end', () => {
    let playbook = createPlaybookState(REVIEW_PROJECT_ARTIFACT_DEFINITION as any, 'generation-bound evidence');

    const classify = processNextStep(playbook);
    expect(classify.action).toBe('spawn_sub_agent');
    playbook = completeSubAgent(classify.updatedPlaybook, 'node-review-classify', '{"artifactTypes":["code_pr"]}').updatedPlaybook;

    const fanout = processNextStep(playbook);
    expect(fanout.action).toBe('node_completed');
    playbook = fanout.updatedPlaybook;
    for (const id of ['node-review-code', 'node-review-deliverable', 'node-review-risk']) {
      const reviewer = processNextStep(playbook);
      expect(reviewer.action).toBe('spawn_sub_agent');
      if (reviewer.action !== 'spawn_sub_agent') throw new Error('expected exclusive reviewer');
      expect(reviewer.nodeId).toBe(id);
      playbook = completeSubAgent(reviewer.updatedPlaybook, id, '{"verdict":"pass"}').updatedPlaybook;
    }

    let step = processNextStep(playbook);
    expect(step.action).toBe('node_completed');
    playbook = step.updatedPlaybook;
    step = processNextStep(playbook);
    expect(step.action).toBe('spawn_sub_agent');
    playbook = completeSubAgent(step.updatedPlaybook, 'node-review-synthesize', '{"disposition":"PASS"}').updatedPlaybook;
    step = processNextStep(playbook);
    expect(step.action).toBe('prompt_agent');
    playbook = completeSubAgent(step.updatedPlaybook, 'node-review-done', 'Independent review complete.').updatedPlaybook;
    step = processNextStep(playbook);
    expect(step.action).toBe('workflow_completed');
    expect(step.updatedPlaybook.status).toBe('completed');
  });
});
