import { describe, expect, it } from '@jest/globals';

import { up } from '../0087_create_project_pipeline_templates';

describe('0087 project pipeline templates migration', () => {
  it('packages one protected core template and ordered reusable stages', () => {
    expect(up).toContain('work_project_pipeline_templates');
    expect(up).toContain('work_project_pipeline_template_stages');
    expect(up).toContain("'core-default-project'");
    expect(up).toContain('system = true');
    expect(up).toContain('locked = true');
    expect(up).toContain("'core-routine-plan-project-task'");
    expect(up).toContain("'core-routine-execute-project-todo'");
    expect(up).toContain("'core-routine-review-project-artifact'");
    expect(up).toContain('pipeline_template_id');
    expect(up).toContain('successTransition');
    expect(up).toContain('"mode":"next"');
    expect(up).toContain('exceptionTransition');
  });

  it('orders planning before todo so next-stage movement returns planned work to execution', () => {
    expect(up.indexOf("'core-stage-planning'")).toBeLessThan(up.indexOf("'core-stage-todo'"));
    expect(up.indexOf("'core-stage-todo'")).toBeLessThan(up.indexOf("'core-stage-in-progress'"));
    expect(up.indexOf("'core-stage-in-review'")).toBeLessThan(up.indexOf("'core-stage-done'"));
  });
});
