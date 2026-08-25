import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

function source(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

describe('Projects orchestration writer contract', () => {
  it('routes dispatcher execution and review transitions through the shared outbox boundary', () => {
    const dispatch = source('pkg/rancher-desktop/agent/database/models/WorkTaskDispatchModel.ts');
    for (const sourceName of [
      'task-dispatch-claim',
      'task-dispatch-finalize',
      'legacy-review-finalize',
      'protected-review-finalize',
      'verification-failure-escalation',
      'duplicate-review-generation',
      'orphan-execution-recovery',
      'expired-execution-lease-recovery',
    ]) {
      expect(dispatch).toContain(`'${ sourceName }'`);
    }
  });

  it('routes blocked planning and durable-wait releases through the same boundary', () => {
    const planning = source('pkg/rancher-desktop/agent/database/models/WorkTaskPlanningRunModel.ts');
    const waits = source('pkg/rancher-desktop/agent/database/models/WorkTaskWaitModel.ts');
    expect(planning).toContain("'planning-run-claim'");
    expect(waits).toContain("'durable-wait-observation'");
    expect(waits).toContain("'durable-wait-failure'");
  });

  it('drains committed events before new dispatcher claims and after settlement', () => {
    const dispatcher = source('pkg/rancher-desktop/agent/services/TaskDispatcherService.ts');
    expect(dispatcher.match(/getProjectsOrchestrationEventService\(\)\.drain\(50\)/g)).toHaveLength(2);
  });

  it('routes human-comment wait invalidation, lane archival, and capability recovery through the outbox', () => {
    const workItems = source('pkg/rancher-desktop/agent/database/models/WorkItemsModel.ts');
    const lanes = source('pkg/rancher-desktop/agent/database/models/WorkLaneDefinitionModel.ts');
    const capabilities = source('pkg/rancher-desktop/agent/database/models/LifecycleCapabilityModel.ts');

    expect(workItems).toContain("'human-comment-wait-invalidation'");
    expect(workItems.slice(workItems.indexOf('static async addComment'))).toContain('appendTaskTransitionEvent(');
    expect(lanes).toContain("'lane-archive-move'");
    expect(capabilities).toContain("'capability-recovery-open'");
    expect(capabilities).toContain("'capability-recovery-resolved'");
  });
});
