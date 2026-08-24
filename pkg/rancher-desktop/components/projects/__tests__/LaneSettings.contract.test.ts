import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

describe('LaneSettings UI contract', () => {
  const source = fs.readFileSync(path.resolve(process.cwd(), 'pkg/rancher-desktop/components/projects/LaneSettings.vue'), 'utf8');

  it('exposes global/project customization, safe archive, and all assignment scopes', () => {
    for (const phrase of [
      'Global defaults', 'This project', 'project-only', 'Reset override', 'Move tasks to',
      'This epic', 'Every project using this lane type', 'Effective now:', 'Protected core',
    ]) expect(source).toContain(phrase);
    expect(source).toContain('previewArchiveLane');
    expect(source).toContain('listCompatibleLaneWorkflows');
    expect(source).toContain('resolveLaneWorkflowContext');
  });

  it('keeps stable identity immutable and uses backend mutations for reversible changes', () => {
    expect(source).toContain(':disabled="!editor.create"');
    expect(source).toContain('resetLaneOverride');
    expect(source).toContain('removeLaneWorkflowBinding');
    expect(source).not.toContain('postgresClient');
  });
});
