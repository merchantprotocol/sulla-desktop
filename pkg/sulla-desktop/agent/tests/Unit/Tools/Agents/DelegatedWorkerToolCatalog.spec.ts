// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import toolPlacements from '../../../../../../../resources/tool-placements.json';

// risk: delegated workers lose their completion/control surface when the tools image catalog drifts.
describe('delegated worker tool catalog', () => {
  it('keeps every worker control tool in the baked manifest catalog and placement policy', () => {
    const delegatedWorkerTools = ['wait', 'report_progress', 'return_result', 'send_job_message'] as const;
    const manifests = readFileSync(path.join(process.cwd(), 'pkg/sulla-desktop/agent/tools/agents/manifests.ts'), 'utf8');
    const catalog = readFileSync(path.join(process.cwd(), 'services/sulla-tools/src/catalog.ts'), 'utf8');

    expect(catalog).toContain("import('../../../pkg/sulla-desktop/agent/tools/manifests.js')");
    expect(catalog).toContain('registry.getToolNamesForCategory(category)');
    for (const name of delegatedWorkerTools) {
      expect(manifests).toMatch(new RegExp(`name:\\s+'${ name }'`));
      expect(toolPlacements.tools[`agents/${ name }`]).toMatchObject({
        category: 'agents',
        name,
        placements: expect.arrayContaining(['desktop']),
        relayable: true,
      });
    }
  });
});
