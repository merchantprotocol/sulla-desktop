// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import toolPlacements from '../../../../../../../resources/tool-placements.json';
import { initializeCatalog, resolveTool } from '../../../../../../../services/sulla-tools/src/catalog';

// risk: delegated workers lose their completion/control surface when the tools image catalog drifts.
describe('delegated worker tool catalog', () => {
  it('keeps every worker control tool placed and resolvable by sulla-tools', async() => {
    const delegatedWorkerTools = ['wait', 'report_progress', 'return_result', 'send_job_message'] as const;

    await initializeCatalog();

    for (const name of delegatedWorkerTools) {
      expect(toolPlacements.tools[`agents/${ name }`]).toMatchObject({
        category: 'agents',
        name,
        placements: expect.arrayContaining(['desktop']),
        relayable: true,
      });
      expect(resolveTool('agents', name)).toMatchObject({
        category: 'agents',
        name,
        executionTarget: 'controller',
      });
    }
  });
});
