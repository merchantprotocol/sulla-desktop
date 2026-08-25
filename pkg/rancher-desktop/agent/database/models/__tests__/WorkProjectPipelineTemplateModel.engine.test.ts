import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { postgresClient } from '../../PostgresClient';
import {
  WorkProjectPipelineTemplateModel, type ProjectPipelineTemplate,
} from '../WorkProjectPipelineTemplateModel';

const contract = {
  input: 'project.lane-entry.v1', output: 'project.lane-outcome.v1',
};

function template(
  id: string,
  name: string,
  stages: { key: string; role: string; workflow: string }[],
): ProjectPipelineTemplate {
  return {
    id,
    template_key: id,
    name,
    description:  '',
    version:      1,
    system:       false,
    locked:       false,
    enabled:      true,
    created_by:   'test',
    updated_by:   null,
    created_at:   new Date(0).toISOString(),
    updated_at:   null,
    archived_at:  null,
    stages:       stages.map((stage, index) => ({
      id:                  `${ id }-${ stage.key }`,
      template_id:         id,
      stage_key:           stage.key,
      display_name:        stage.key,
      description:         '',
      position:            (index + 1) * 10,
      semantic_role:       stage.role,
      bundled_workflow_id: stage.workflow,
      entry_policy:        {},
      wip_limit:           null,
    })),
  };
}

describe('project pipeline template engine', () => {
  const originalTransaction = postgresClient.transaction;

  afterEach(() => {
    (postgresClient as any).transaction = originalTransaction;
    jest.restoreAllMocks();
  });

  it('materializes coding and non-coding pipelines through the identical configured-stage engine', async() => {
    const coding = template('coding', 'Coding', [
      { key: 'plan', role: 'planning', workflow: 'plan-routine' },
      { key: 'build', role: 'execution', workflow: 'build-routine' },
      { key: 'review', role: 'review', workflow: 'review-routine' },
    ]);
    const publishing = template('publishing', 'Publishing', [
      { key: 'research', role: 'manual', workflow: 'research-routine' },
      { key: 'draft', role: 'manual', workflow: 'draft-routine' },
      { key: 'approve', role: 'manual', workflow: 'approval-routine' },
      { key: 'publish', role: 'terminal', workflow: 'publish-routine' },
    ]);
    jest.spyOn(WorkProjectPipelineTemplateModel, 'get').mockImplementation((id) =>
      Promise.resolve(id === coding.id ? coding : id === publishing.id ? publishing : null));

    const calls: { sql: string; params: unknown[] }[] = [];
    const client = {
      query: jest.fn((sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.includes('SELECT id FROM work_projects')) return Promise.resolve({ rows: [{ id: params[0] }] });
        if (sql.includes('SELECT count(*)::text AS count')) return Promise.resolve({ rows: [{ count: '0' }] });
        if (sql.includes('SELECT id, definition FROM workflows')) {
          return Promise.resolve({ rows: [{ id: params[0], definition: { laneContract: contract } }] });
        }
        return Promise.resolve({ rows: [] });
      }),
    };
    (postgresClient as any).transaction = (jest.fn() as any).mockImplementation((callback: any) => callback(client));

    await WorkProjectPipelineTemplateModel.applyToProject('coding-project', coding.id, 'test');
    await WorkProjectPipelineTemplateModel.applyToProject('publishing-project', publishing.id, 'test');

    const laneInserts = calls.filter(call => call.sql.includes('INSERT INTO work_lane_definitions'));
    expect(laneInserts).toHaveLength(coding.stages.length + publishing.stages.length);
    expect(laneInserts.map(call => call.params[1])).toEqual([
      'plan', 'build', 'review', 'research', 'draft', 'approve', 'publish',
    ]);
    const bindingInserts = calls.filter(call => call.sql.includes('INSERT INTO work_lane_workflow_bindings'));
    expect(bindingInserts).toHaveLength(laneInserts.length);
    expect(calls.filter(call => call.sql.includes('UPDATE work_projects SET pipeline_template_id'))
      .map(call => call.params)).toEqual([
      ['coding-project', 'coding'], ['publishing-project', 'publishing'],
    ]);
  });
});
