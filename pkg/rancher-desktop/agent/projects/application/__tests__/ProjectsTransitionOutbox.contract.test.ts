import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

describe('Projects transition outbox contract', () => {
  const source = fs.readFileSync(path.resolve(
    process.cwd(), 'pkg/rancher-desktop/agent/database/models/WorkItemsModel.ts',
  ), 'utf8');

  it('records the transition event inside the task/lane-entry transaction', () => {
    const transaction = source.slice(source.indexOf('updated = await postgresClient.transaction'));
    expect(transaction).toContain('claimLaneEntryInTransaction');
    expect(transaction).toContain('createPostgresProjectsRepositories(client).events.append');
    expect(transaction).toContain("eventType:      'projects.task.transitioned'");
    expect(transaction).toContain('claimed.entry.generation');
  });

  it('uses task and generation as its replay identity', () => {
    expect(source).toContain('projects.task.transitioned:${ committed.id }:${ claimed.entry.generation }');
  });
});
