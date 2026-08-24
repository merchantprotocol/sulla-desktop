import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import mockModules from '@pkg/utils/testUtils/mockModules';

const invoke = jest.fn((_channel: string) => Promise.resolve({}));
mockModules({ '@pkg/utils/ipcRenderer': { ipcRenderer: { invoke } } });

const { useProjects } = await import('../useProjects');

describe('useProjects board hydration', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('hydrates the lane contract consumed during ProjectsHome setup', async() => {
    const lane = {
      id:                      'lane-done',
      lane_key:                'finished',
      scope:                   'project',
      project_id:              'project-1',
      base_lane_key:           null,
      display_name:            'Finished',
      description:             '',
      color:                   null,
      icon:                    null,
      position:                1,
      semantic_role:           'terminal',
      enabled:                 true,
      archived:                false,
      system_required:         false,
      created_by:              'human',
      updated_by:              null,
      created_at:              '2026-08-24T00:00:00.000Z',
      updated_at:              null,
      archived_at:             null,
      reset_at:                null,
      provenance:              'project_only',
      inherited_definition_id: null,
    };
    const capability = { ready: true, catalogPresent: true, missingRoles: [], degradedReason: null };
    invoke.mockResolvedValueOnce({
      projects: [{ id: 'project-1', title: 'Project', status: 'working' }],
      epics:    [{ id: 'epic-1', project_id: 'project-1', title: 'Epic', position: 0 }],
      tasks:    [{
        id:              'task-1',
        project_id:      'project-1',
        epic_id:         'epic-1',
        parent_id:       null,
        title:           'Task',
        status:          'finished',
        priority:        'high',
        position:        0,
        created_at:      '2026-08-24T00:00:00.000Z',
        knowledge_count: 2,
      }],
      lanesByProject: { 'project-1': [lane] },
      laneCapability: capability,
    });

    const state = useProjects();
    await state.load();

    expect(state.lanesByProject.value).toEqual({ 'project-1': [lane] });
    expect(state.laneCapability.value).toEqual(capability);
    expect(state.projects.value[0].epics[0].tasks[0]).toMatchObject({ lane, knowledge_count: 2 });
    expect(state.projects.value[0]).toMatchObject({ openCount: 0, doneCount: 1 });
  });

  it('falls back to stable terminal keys when lane metadata is unavailable', async() => {
    invoke.mockResolvedValueOnce({
      projects: [{ id: 'project-1', title: 'Project', status: 'working' }],
      epics:    [{ id: 'epic-1', project_id: 'project-1', title: 'Epic', position: 0 }],
      tasks:    [{
        id:         'task-1',
        project_id: 'project-1',
        epic_id:    'epic-1',
        parent_id:  null,
        title:      'Task',
        status:     'parked',
        priority:   'medium',
        position:   0,
        created_at: '2026-08-24T00:00:00.000Z',
      }],
    });

    const state = useProjects();
    await state.load();

    expect(state.projects.value[0]).toMatchObject({ openCount: 0, doneCount: 1 });
    expect(state.lanesByProject.value).toEqual({});
    expect(state.laneCapability.value).toBeNull();
  });
});
