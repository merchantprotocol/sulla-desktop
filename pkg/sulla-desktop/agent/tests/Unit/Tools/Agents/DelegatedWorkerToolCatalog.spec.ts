// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import toolPlacements from '../../../../../../../resources/tool-placements.json';
import { executionTargetFor } from '../../../../../tools/executionTargets';
import { agentToolManifests } from '../../../../../tools/agents/manifests';

// risk: delegated workers lose their completion/control surface when the tools image catalog drifts.
describe('delegated worker tool catalog', () => {
  it('keeps every worker control tool in the baked manifest catalog and placement policy', () => {
    const delegatedWorkerTools = ['wait', 'report_progress', 'return_result', 'send_job_message'] as const;

    for (const name of delegatedWorkerTools) {
      const manifest = agentToolManifests.find(tool => tool.name === name && tool.category === 'agents');

      expect(manifest).toBeDefined();
      expect(executionTargetFor('agents', name)).toBe('controller');
      expect(toolPlacements.tools[`agents/${ name }`]).toMatchObject({
        category: 'agents',
        name,
        placements: expect.arrayContaining(['desktop']),
        relayable: true,
      });
    }
  });
});
