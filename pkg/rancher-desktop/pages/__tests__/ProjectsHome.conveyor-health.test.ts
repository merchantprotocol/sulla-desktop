import fs from 'node:fs';

import { describe, expect, it } from '@jest/globals';
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc';

const source = fs.readFileSync('pkg/rancher-desktop/pages/ProjectsHome.vue', 'utf8');

describe('Projects conveyor health panel', () => {
  it('exposes selectable windows, project/portfolio scope, and bounded stage drill-down', () => {
    expect(source).toContain('aria-label="Projects conveyor health"');
    expect(source).toContain('v-model.number="conveyorWindow"');
    expect(source).toContain('healthScopeProject');
    expect(source).toContain("'work-items:conveyor-oldest'");
    expect(source).toContain('openHealthTask');
  });

  it('renders all required health signals without trusting comments as evidence', () => {
    for (const signal of [
      'Throughput', 'Verifier', 'Rework', 'Wait adoption', 'Custody',
      'Stale leases', 'Dependency held', 'Shipments',
    ]) expect(source).toContain(signal);
    expect(source).not.toContain('work_task_comments');
  });

  it('compiles the real SFC script and template without diagnostics', () => {
    const { descriptor, errors } = parse(source, { filename: 'ProjectsHome.vue' });
    expect(errors).toEqual([]);
    expect(() => compileScript(descriptor, { id: 'projects-health' })).not.toThrow();
    const template = compileTemplate({
      id: 'projects-health', filename: 'ProjectsHome.vue', source: descriptor.template?.content ?? '',
    });
    expect(template.errors).toEqual([]);
  });
});
