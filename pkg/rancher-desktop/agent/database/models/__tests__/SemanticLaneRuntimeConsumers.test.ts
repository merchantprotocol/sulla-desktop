import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { postgresClient } from '../../PostgresClient';
import { up as semanticRuntimeMigration } from '../../migrations/0074_semantic_lane_runtime_helpers';
import { WorkLaneDefinitionModel } from '../WorkLaneDefinitionModel';
import { WorkTaskDispatchModel } from '../WorkTaskDispatchModel';

describe('semantic lane runtime consumers', () => {
  const originalTransaction = postgresClient.transaction;

  afterEach(() => {
    (postgresClient as any).transaction = originalTransaction;
    jest.restoreAllMocks();
  });

  it('claims a project-specific execution entry and moves it to its resolved active lane', async() => {
    const query = (jest.fn() as any)
      .mockResolvedValueOnce({
        rows: [{
          id:              'task-1',
          project_id:      'project-1',
          epic_id:         'epic-1',
          status:          'ready-custom',
          active_lane_key: 'building-custom',
          labels:          [],
        }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'dispatch-1', task_id: 'task-1', kind: 'execution' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'task-1' }] });
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));

    await expect(WorkTaskDispatchModel.claimNext('opus-worker')).resolves.toMatchObject({
      task: { status: 'ready-custom' }, dispatch: { task_id: 'task-1' },
    });
    expect(query.mock.calls[0][0]).toContain("resolve_work_task_lane_role(t.id, t.status) = 'execution'");
    expect(query.mock.calls[0][0]).toContain("resolve_project_lane_key(t.project_id, 'execution', 'in_progress', true)");
    expect(query.mock.calls[0][0]).toContain('work_lane_entry_automations');
    expect(query.mock.calls[2][1]).toEqual(['task-1', 'building-custom', 'dispatcher', 'ready-custom']);
  });

  it('uses project lane order rather than seeded keys for entry and active destinations', async() => {
    jest.spyOn(WorkLaneDefinitionModel, 'runtimeCapability').mockResolvedValue({
      ready: true, catalogPresent: true, missingRoles: [], degradedReason: null,
    });
    jest.spyOn(WorkLaneDefinitionModel, 'resolveEffective').mockResolvedValue([
      { lane_key: 'ready-custom', semantic_role: 'execution', position: 1 } as any,
      { lane_key: 'todo', semantic_role: 'execution', position: 2 } as any,
      { lane_key: 'in_progress', semantic_role: 'execution', position: 3 } as any,
      { lane_key: 'building-custom', semantic_role: 'execution', position: 4 } as any,
    ]);

    await expect(WorkLaneDefinitionModel.preferredLaneKey(
      'project-1', 'execution', 'todo', 'first',
    )).resolves.toBe('ready-custom');
    await expect(WorkLaneDefinitionModel.preferredLaneKey(
      'project-1', 'execution', 'in_progress', 'last',
    )).resolves.toBe('building-custom');
  });

  it('claims any effective review lane and leaves manual lanes outside the verifier pool', async() => {
    const query = (jest.fn() as any).mockResolvedValueOnce({ rows: [] });
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));

    await expect(WorkTaskDispatchModel.claimNextReview('codex-test')).resolves.toBeNull();
    expect(query.mock.calls[0][0]).toContain("resolve_work_task_lane_role(t.id, t.status) = 'review'");
    expect(query.mock.calls[0][0]).not.toContain("t.status = 'in_review'");
  });

  it('keeps unknown lanes lossless and confines fixed keys to deterministic fallback helpers', () => {
    expect(semanticRuntimeMigration).toContain("RETURN COALESCE(resolved_role, 'manual')");
    expect(semanticRuntimeMigration).toContain('RETURN CASE');
    expect(semanticRuntimeMigration).toContain("ELSE 'manual'");
    expect(semanticRuntimeMigration).toContain('resolve_project_lane_key');
    expect(semanticRuntimeMigration).toContain("resolve_work_task_lane_role(NEW.id, NEW.status) = 'terminal'");
  });

  it('keeps every runtime surface on semantic roles and effective binding ownership', () => {
    const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
    const dispatch = source('pkg/rancher-desktop/agent/database/models/WorkTaskDispatchModel.ts');
    const planning = source('pkg/rancher-desktop/agent/services/PlanningCouncilService.ts');
    const waits = source('pkg/rancher-desktop/agent/database/models/WorkTaskWaitModel.ts');
    const heartbeat = source('pkg/rancher-desktop/agent/nodes/HeartbeatNode.ts');
    const report = source('pkg/rancher-desktop/agent/prompts/projectReport.ts');
    const heartbeatPrompt = source('pkg/rancher-desktop/agent/prompts/heartbeat.ts');
    const composable = source('pkg/rancher-desktop/composables/useProjects.ts');
    const projectsPage = source('pkg/rancher-desktop/pages/ProjectsHome.vue');

    expect(dispatch).toContain('resolve_work_task_lane_role');
    expect(dispatch).toContain('work_lane_entry_automations');
    expect(planning).toContain('semantic_role');
    expect(waits).toContain('semanticRoleForStatus');
    expect(heartbeat).toContain("semanticRoles: ['backlog', 'execution']");
    expect(heartbeat).toContain('filterHeartbeatEligible');
    expect(report).toContain('laneFor(task)?.semantic_role');
    expect(heartbeatPrompt).toContain("Resolve every task's effective lane and semantic role");
    expect(heartbeatPrompt).toContain('ordered effective execution-entry lane');
    expect(heartbeatPrompt).not.toContain("Send incomplete work to 'planning'; send executable work to 'todo'");
    expect(composable).toContain("t.lane?.semantic_role === 'terminal'");
    expect(projectsPage).toContain('function semanticRole(status: string)');
    expect(projectsPage).toContain("lane.semantic_role === 'execution'");
    expect(projectsPage).toContain("if (!laneCapability.value?.ready) return 'todo'");
    expect(projectsPage).not.toContain("fillTaskDraft({ epic_id: epicId, status: 'todo'");
  });
});
