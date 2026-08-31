import { describe, expect, it, jest } from '@jest/globals';

import { down, up } from '../0075_add_project_views_and_scheduling';

describe('0075_add_project_views_and_scheduling', () => {
  it('adds canonical schedule fields, dependencies, scoped views, and schedule audit', async() => {
    const query = jest.fn<(sql: string) => Promise<void>>(() => Promise.resolve());
    await up({ query } as any);
    const sql = query.mock.calls[0][0];

    expect(sql).toContain('ALTER TABLE work_tasks ADD COLUMN IF NOT EXISTS start_at');
    expect(sql).toContain('ALTER TABLE work_tasks ADD COLUMN IF NOT EXISTS milestone_at');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS work_task_dependencies');
    expect(sql).toContain('CHECK (task_id <> depends_on_task_id)');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS work_project_views');
    expect(sql).toContain("CHECK (view_type IN ('board', 'table', 'gantt', 'calendar', 'list'))");
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS work_schedule_audit');
  });

  it('has a reversible down path', async() => {
    const query = jest.fn<(sql: string) => Promise<void>>(() => Promise.resolve());
    await down({ query } as any);
    const sql = query.mock.calls[0][0];
    expect(sql).toContain('DROP TABLE IF EXISTS work_project_views');
    expect(sql).toContain('ALTER TABLE work_tasks DROP COLUMN IF EXISTS start_at');
  });
});
