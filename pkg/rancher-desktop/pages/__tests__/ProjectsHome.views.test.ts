import fs from 'fs';

import { describe, expect, it } from '@jest/globals';
import { compileScript, compileStyle, compileTemplate, parse } from '@vue/compiler-sfc';

import { formatDateOnly } from '../../agent/utils/formatDateOnly';

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

  it('formats PostgreSQL Date values through the shared date boundary helper', () => {
    expect(formatDateOnly(new Date('2026-09-01T18:00:00.000Z'))).toBe('2026-09-01');
    expect(formatDateOnly('2026-09-01T18:00:00.000Z')).toBe('2026-09-01');
    expect(formatDateOnly(null)).toBe('');
    expect(source).toContain("import { formatDateOnly } from '@pkg/agent/utils/formatDateOnly'");
    expect(source).toContain('return formatDateOnly(value);');
    expect(source).not.toContain("return iso ? iso.slice(0, 10) : '';");
  });

  it('compiles the real light/dark SFC render and style paths without diagnostics', () => {
    const { descriptor, errors } = parse(source, { filename: 'ProjectsHome.vue' });
    expect(errors).toEqual([]);
    expect(() => compileScript(descriptor, { id: 'projects-home' })).not.toThrow();
    const template = compileTemplate({
      id:       'projects-home',
      filename: 'ProjectsHome.vue',
      source:   descriptor.template?.content ?? '',
    });
    expect(template.errors).toEqual([]);
    const style = compileStyle({
      id:             'projects-home',
      filename:       'ProjectsHome.vue',
      source:         descriptor.styles[0].content.replace(/^@import[^;]+;$/m, '@mixin routines-theme-vars {}'),
      scoped:         true,
      preprocessLang: 'scss',
    });
    expect(style.errors).toEqual([]);
    expect(style.code).toContain('html.light');
    expect(style.code).toContain('#0b0f17');
    expect(source).toContain('aria-pressed');
    expect(source).toContain('role="grid"');
    expect(source).toContain(':focus-visible');
  });

  it('bounds every projection, persists the last-used view automatically, and exposes dependency controls', () => {
    expect(source).toContain('const PROJECTION_RENDER_LIMIT = 500');
    expect(source).toContain('boundedVisibleTasks');
    expect(source).toContain('persistProjectView');
    expect(source).toContain('addDependency');
    expect(source).toContain('Move $' + '{t.title} to lane');
  });
});
