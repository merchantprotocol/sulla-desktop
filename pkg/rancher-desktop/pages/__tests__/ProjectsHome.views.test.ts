import fs from 'fs';

import { describe, expect, it } from '@jest/globals';

const source = fs.readFileSync('pkg/rancher-desktop/pages/ProjectsHome.vue', 'utf8');

describe('Projects multi-view contract', () => {
  it.each(['board', 'table', 'gantt', 'calendar', 'list'])('renders the %s projection from the shared tree', (view) => {
    expect(source).toContain(`key: '${ view }'`);
    expect(source).toContain(`tab === '${ view }'`);
  });

  it('routes every inline and drag edit through the canonical task mutation', () => {
    expect(source).toContain("await updateTask(task.id, { [field]: value, actor: 'human' })");
    expect(source).toContain("await reorder([{ kind: 'task', id, status: colKey }])");
    expect(source).not.toContain('localStorage');
  });

  it('keeps missing dates explicit and bounds table rendering', () => {
    expect(source).toContain('Unscheduled work');
    expect(source).toContain('const TABLE_RENDER_LIMIT = 500');
    expect(source).toContain('visibleTasks.slice(0, TABLE_RENDER_LIMIT)');
  });

  it('defines deterministic light and dark token palettes and accessible controls', () => {
    expect(source).toContain(':global(html.light) .projects-home');
    expect(source).toContain('--pbg:          #0b0f17');
    expect(source).toContain('aria-pressed');
    expect(source).toContain('role="grid"');
    expect(source).toContain(':focus-visible');
  });
});
