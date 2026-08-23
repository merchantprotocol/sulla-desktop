import { describe, expect, it } from '@jest/globals';

import { projectToolManifests } from '../manifests';

describe('project lane tools', () => {
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

  it('loads every lane worker through its manifest', async() => {
    const laneTools = projectToolManifests.filter(tool => tool.name.includes('lane'));
    for (const tool of laneTools) {
      const module = await tool.loader();
      expect(Object.values(module).some((value: any) =>
        typeof value === 'function' && typeof value.prototype?._validatedCall === 'function')).toBe(true);
    }
  });
});
