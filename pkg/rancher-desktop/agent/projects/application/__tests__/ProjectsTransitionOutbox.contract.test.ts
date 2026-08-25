import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

describe('Projects transition outbox contract', () => {
  const source = fs.readFileSync(path.resolve(
    process.cwd(), 'pkg/rancher-desktop/agent/database/models/WorkItemsModel.ts',
  ), 'utf8');
  const appendSource = fs.readFileSync(path.resolve(
    process.cwd(), 'pkg/rancher-desktop/agent/projects/infrastructure/appendTaskTransitionEvent.ts',
  ), 'utf8');

  it('records the transition event inside the task/lane-entry transaction', () => {
    const transaction = source.slice(source.indexOf('updated = await postgresClient.transaction'));
    expect(transaction).toContain('appendTaskTransitionEvent(');
    expect(appendSource).toContain('claimLaneEntryInTransaction');
    expect(appendSource).toContain('createPostgresProjectsRepositories(client).events.append');
    expect(appendSource).toContain("eventType:      'projects.task.transitioned'");
    expect(appendSource).toContain('claimed.entry.generation');
  });

  it('uses task and generation as its replay identity', () => {
    expect(appendSource).toContain('projects.task.transitioned:${ task.id }:${ claimed.entry.generation }');
  });

  it('dispatches orchestration only through the durable event service after commit', () => {
    expect(source).toContain('getProjectsOrchestrationEventService().drain()');
    expect(source).not.toContain('LaneEntryAutomationService.dispatchEntry(laneEntryId)');
  });
});
