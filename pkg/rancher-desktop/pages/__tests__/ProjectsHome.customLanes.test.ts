import fs from 'node:fs';

import { describe, expect, it } from '@jest/globals';

const source = fs.readFileSync('pkg/rancher-desktop/pages/ProjectsHome.vue', 'utf8');

describe('Projects renderer custom-lane contract (dHAe Phase 6)', () => {
  it('derives status options solely from the project\'s own configured lanes', () => {
    expect(source).toContain('const STATUSES = computed(() => selectedLanes.value.map(lane => lane.lane_key))');
  });

  it('carries no literal coding-lifecycle lane-key fallback that could leak into a non-coding pipeline', () => {
    // The exact hardcoded set this refactor removed. If this reappears, a project running
    // a genuinely custom (non-coding) pipeline would silently see the wrong status options
    // whenever its lanes haven't resolved yet, instead of an empty, honestly-loading list.
    expect(source).not.toContain('COMPATIBILITY_LANE_KEYS');
    expect(source).not.toContain("['backlog', 'todo', 'planning', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled', 'parked']");
  });

  it('renders the board, table, and task-drawer status pickers from the same server-owned lane list', () => {
    const statusPickerSites = source.match(/v-for="s(tatus)? in STATUSES"/g) ?? [];
    expect(statusPickerSites.length).toBeGreaterThanOrEqual(4);
  });

  it('sources lane options from the server-owned lanesByProject DTO, not a client-computed list', () => {
    expect(source).toContain("const selectedLanes = computed(() => selectedId.value ? (lanesByProject.value[selectedId.value] ?? []) : [])");
  });
});
