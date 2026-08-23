import { describe, expect, it } from '@jest/globals';

import { REVIEW_PROJECT_ARTIFACT_DEFINITION } from '../../routines/core/reviewProjectArtifact';
import { completeSubAgent, createPlaybookState, processNextStep } from '../WorkflowPlaybook';

describe('protected review workflow engine', () => {
  it('runs classification, parallel independent reviews, synthesis, and response end to end', () => {
    let playbook = createPlaybookState(REVIEW_PROJECT_ARTIFACT_DEFINITION as any, 'generation-bound evidence');

    const classify = processNextStep(playbook);
    expect(classify.action).toBe('spawn_sub_agent');
    playbook = completeSubAgent(classify.updatedPlaybook, 'node-review-classify', '{"artifactTypes":["code_pr"]}').updatedPlaybook;

    const fanout = processNextStep(playbook);
    expect(fanout.action).toBe('node_completed');
    const reviewers = processNextStep(fanout.updatedPlaybook);
    expect(reviewers.action).toBe('spawn_parallel_agents');
    if (reviewers.action !== 'spawn_parallel_agents') throw new Error('review council did not fan out');
    expect(reviewers.nodes.map(node => node.nodeId).sort()).toEqual([
      'node-review-code', 'node-review-deliverable', 'node-review-risk',
    ]);
    playbook = reviewers.updatedPlaybook;
    for (const node of reviewers.nodes) {
      playbook = completeSubAgent(playbook, node.nodeId, `{"verdict":"pass","lens":"${ node.nodeId }"}`).updatedPlaybook;
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
