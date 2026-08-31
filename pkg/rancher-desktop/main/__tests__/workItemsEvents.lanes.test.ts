import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

describe('work-items lane IPC contract', () => {
  it('registers every lane mutation and resolver through the Projects application boundary', () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), 'pkg/rancher-desktop/main/workItemsEvents.ts'), 'utf8');
    for (const channel of [
      'work-items:lanes-list', 'work-items:lanes-resolve', 'work-items:lane-create',
      'work-items:lane-update', 'work-items:lane-archive', 'work-items:lane-restore',
      'work-items:lane-archive-preview',
      'work-items:lanes-reorder', 'work-items:lane-reset-override',
      'work-items:lane-bindings-list', 'work-items:lane-binding-set',
      'work-items:lane-binding-remove', 'work-items:lane-workflow-resolve',
      'work-items:lane-workflow-resolve-context', 'work-items:lane-compatible-workflows',
      'work-items:lane-entry-automations',
    ]) expect(source).toContain(`handle('${ channel }'`);
    expect(source).toContain("import('@pkg/agent/projects/application/ProjectsApplicationService')");
    expect(source).not.toContain("import('@pkg/agent/database/models/WorkLaneDefinitionModel')");
    expect(source).not.toContain("import('@pkg/agent/database/models/WorkLaneWorkflowBindingModel')");
  });
});
