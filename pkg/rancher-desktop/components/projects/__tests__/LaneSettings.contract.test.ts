import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

describe('LaneSettings UI contract', () => {
  const source = fs.readFileSync(path.resolve(process.cwd(), 'pkg/rancher-desktop/components/projects/LaneSettings.vue'), 'utf8');

  it('exposes global/project customization and safe archive', () => {
    for (const phrase of [
      'Global defaults', 'This project', 'project-only', 'Reset override', 'Move tasks to',
    ]) expect(source).toContain(phrase);
    expect(source).toContain('previewArchiveLane');
  });

  it('keeps stable identity immutable and uses backend mutations for reversible changes', () => {
    expect(source).toContain(':disabled="!editor.create"');
    expect(source).toContain('resetLaneOverride');
    expect(source).not.toContain('postgresClient');
  });

  it('has no lane-trigger or approval-gate controls: lanes never launch or hold work', () => {
    for (const removed of [
      'Assign workflow', 'LaneWorkflowBinding', 'resolveLaneWorkflowContext', 'listCompatibleLaneWorkflows',
      'requiresHumanApproval', 'requires_human_approval', 'automated-capable',
    ]) expect(source).not.toContain(removed);
  });
});
