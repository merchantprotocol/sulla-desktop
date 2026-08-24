import fs from 'node:fs';
import path from 'node:path';

import { LegacyProjectsMapper } from '../compatibility';
import { DomainError } from '../errors';

describe('Projects legacy compatibility', () => {
  it.each([
    ['backlog', 'backlog'], ['todo', 'execution'], ['planning', 'planning'],
    ['in_progress', 'execution'], ['in_review', 'review'], ['blocked', 'blocked'],
    ['done', 'terminal'], ['cancelled', 'terminal'], ['parked', 'manual'],
  ])('maps legacy status %s to semantic role %s', (status, role) => {
    const task = LegacyProjectsMapper.task({
      id: 'task-1', project_id: 'project-1', epic_id: null, title: 'Task', status,
      assignee: null, labels: null, archived: false,
    });
    expect(task.lane.value).toBe(status);
    expect(task.semanticRole.value).toBe(role);
  });

  it('preserves nullable epic, labels, archive state, and artifact identity', () => {
    const task = LegacyProjectsMapper.task({
      id: 'task-1', project_id: 'project-1', epic_id: null, title: 'Task', status: 'todo',
      assignee: ' worker ', labels: ['p0'], archived: true,
    }, { generation: 4, artifact_hash: 'sha-4' });
    expect(task.epicId).toBeNull();
    expect(task.assignee).toBe('worker');
    expect(task.labels).toEqual(['p0']);
    expect(task.archived).toBe(true);
    expect(task.artifactGeneration.toString()).toBe('gen:4#sha-4');
  });

  it('uses configured semantic roles for custom lanes and fails closed when absent', () => {
    const board = LegacyProjectsMapper.board('project-1', [
      { lane_key: 'build_it', semantic_role: 'execution', position: 0, enabled: true },
      { lane_key: 'verify_it', semantic_role: 'review', position: 1, enabled: true },
    ]);
    expect(board.nextLane(board.lanes[0].key)?.key.value).toBe('verify_it');
    expect(() => LegacyProjectsMapper.board('project-1', [
      { lane_key: 'mystery', semantic_role: null, position: 0, enabled: true },
    ])).toThrow(DomainError);
  });

  it('keeps the domain kernel free of database, Electron, tool, and service imports', () => {
    const root = path.resolve(process.cwd(), 'pkg/rancher-desktop/agent/domain/projects');
    const files: string[] = [];
    const visit = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(target);
        else if (entry.name.endsWith('.ts') && !target.includes(`${ path.sep }__tests__${ path.sep }`)) files.push(target);
      }
    };
    visit(root);
    const forbidden = /from ['"][^'"]*(?:database|electron|tools|services)[^'"]*['"]/;
    expect(files.filter(file => forbidden.test(fs.readFileSync(file, 'utf8')))).toEqual([]);
  });
});
