/** @jest-environment node */
import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { getProjectsApplicationService } from '../../../projects/application/ProjectsApplicationService';
import { CreateProjectWorker } from '../create_project';
import { projectToolManifests } from '../manifests';
import { UpdateProjectWorker } from '../update_project';

const REMOVED_DISPATCHER_TOOLS = [
  'conveyor_health', 'claim_task_lease', 'release_task_lease', 'heartbeat_task_lease',
  'attach_task_evidence', 'settle_task_wait', 'settle_stage_generation', 'register_task_wait',
  'cancel_task_wait', 'list_task_waits', 'reject_task_review', 'transition_task_stage',
  'transition_task_relative', 'transition_task_to_execution', 'explain_task_claimability',
];

describe('simple Projects tool surface', () => {
  afterEach(() => { jest.restoreAllMocks() });

  it('ships no dispatcher, lease, wait, or conveyor tools', () => {
    const names = new Set(projectToolManifests.map(tool => tool.name));
    for (const name of REMOVED_DISPATCHER_TOOLS) expect(names.has(name)).toBe(false);
  });

  it('documents assignedAgent on create_project and update_project and drops dispatch_enabled', () => {
    for (const toolName of ['create_project', 'update_project']) {
      const manifest = projectToolManifests.find(tool => tool.name === toolName)!;
      expect(manifest.schemaDef).toHaveProperty('assignedAgent');
      expect(manifest.schemaDef).not.toHaveProperty('dispatch_enabled');
    }
    const text = JSON.stringify(projectToolManifests);
    expect(text).not.toMatch(/dispatcher|dispatch_enabled/);
  });

  it('create_project stores assignedAgent as assigned_agent', async() => {
    const projects = getProjectsApplicationService() as any;
    jest.spyOn(projects, 'ready').mockResolvedValue(undefined);
    jest.spyOn(projects, 'getProjectBySlug').mockResolvedValue(null);
    const create = jest.spyOn(projects, 'createProject').mockImplementation((input: any) => Promise.resolve({
      id:                   'p1',
      slug:                 input.slug,
      title:                input.title,
      status:               'working',
      priority:             'p2',
      assigned_agent:       input.assigned_agent,
      pipeline_template_id: 'core',
    }));

    const result = await (new CreateProjectWorker() as any)._validatedCall({ title: 'Launch', assignedAgent: ' project-manager ' });

    expect(result.successBoolean).toBe(true);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ assigned_agent: 'project-manager' }), expect.anything());
    expect(result.responseString).toContain('assigned_agent: project-manager');
  });

  it('update_project sets, clears, or leaves the assigned agent alone', async() => {
    const projects = getProjectsApplicationService() as any;
    jest.spyOn(projects, 'ready').mockResolvedValue(undefined);
    const update = jest.spyOn(projects, 'updateProject').mockImplementation((id: any, changes: any) => Promise.resolve({
      id,
      title:          'Launch',
      status:         'working',
      priority:       'p2',
      assigned_agent: changes.assigned_agent ?? null,
      last_moved_at:  '',
    }));
    const worker = new UpdateProjectWorker() as any;

    await worker._validatedCall({ id: 'p1', assignedAgent: 'project-manager' });
    await worker._validatedCall({ id: 'p1', assignedAgent: '' });
    await worker._validatedCall({ id: 'p1', title: 'Renamed' });
    const bad = await worker._validatedCall({ id: 'p1', assignedAgent: 42 });

    expect(update.mock.calls[0][1]).toMatchObject({ assigned_agent: 'project-manager' });
    expect(update.mock.calls[1][1]).toMatchObject({ assigned_agent: null });
    expect((update.mock.calls[2][1] as any).assigned_agent).toBeUndefined();
    expect(bad.successBoolean).toBe(false);
  });
});
