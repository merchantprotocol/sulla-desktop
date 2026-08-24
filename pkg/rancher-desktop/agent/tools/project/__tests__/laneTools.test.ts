import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { WorkLaneDefinitionModel } from '../../../database/models/WorkLaneDefinitionModel';
import { projectToolManifests } from '../manifests';
import { UpdateLaneWorker } from '../update_lane';

describe('project lane tools', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('registers the full lane-definition surface', () => {
    const names = new Set(projectToolManifests.map(tool => tool.name));
    for (const name of [
      'list_lanes', 'resolve_lanes', 'create_lane', 'update_lane',
      'archive_lane', 'restore_lane', 'reorder_lanes', 'reset_lane_override',
    ]) expect(names.has(name)).toBe(true);
  });

  it('does not expose lane_key as an update field', () => {
    const update = projectToolManifests.find(tool => tool.name === 'update_lane');
    expect(update?.schemaDef).not.toHaveProperty('lane_key');
  });

  it('returns a safe tool error when update_lane tries to disable a lane', async() => {
    jest.spyOn(WorkLaneDefinitionModel, 'ensureTable').mockResolvedValue();
    const update = jest.spyOn(WorkLaneDefinitionModel, 'update')
      .mockRejectedValue(new Error('Lanes cannot be disabled directly; use archive_lane so populated lanes are moved atomically.'));

    const result = await (new UpdateLaneWorker() as any)._validatedCall({ id: 'lane-1', enabled: false });

    expect(update).toHaveBeenCalledWith('lane-1', expect.objectContaining({ enabled: false }));
    expect(result.successBoolean).toBe(false);
    expect(result.responseString).toContain('use archive_lane');
  });

  it('loads every lane worker through its manifest', async() => {
    const laneTools = projectToolManifests.filter(tool => tool.name.includes('lane'));
    for (const tool of laneTools) {
      const module = await tool.loader();
      expect(Object.values(module).some((value: any) =>
        typeof value === 'function' && typeof value.prototype?._validatedCall === 'function')).toBe(true);
    }
  });
});
