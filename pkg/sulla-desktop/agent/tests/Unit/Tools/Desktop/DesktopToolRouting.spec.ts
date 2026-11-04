// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';
import { DesktopWorker } from '../../../../tools/desktop/desktop';
import { desktopToolManifests } from '../../../../tools/desktop/manifests';
import { ToolRegistry } from '../../../../tools/registry';

class DesktopToolRoutingHarness {
  readonly registry = new ToolRegistry();

  constructor() {
    this.registry.register('snapshot', 'browser snapshot', 'browser', async() => ({ name: 'snapshot', metadata: { category: 'browser' } }));
    this.registry.registerManifests(desktopToolManifests);
  }
}

describe('desktop tool routing', () => {
  it('registers the colliding desktop snapshot under its category and resolves it exactly', async() => {
    // risk: privacy — desktop calls must reach DesktopTargetPolicy rather than browser tooling.
    const harness = new DesktopToolRoutingHarness();
    expect(harness.registry.getToolNamesForCategory('desktop')).toContain('desktop_snapshot');
    const tool = await harness.registry.createToolForCategory('desktop', 'snapshot');
    expect(tool).toBeInstanceOf(DesktopWorker);
    expect(tool.name).toBe('snapshot');
    expect(tool.metadata.category).toBe('desktop');
  });

  it('fails closed instead of falling back to another category bare name', async() => {
    // risk: authorization — a category/tool mismatch must never execute a different capability.
    const harness = new DesktopToolRoutingHarness();
    await expect(harness.registry.createToolForCategory('desktop', 'missing')).rejects.toThrow('Tool desktop/missing not registered');
    await expect(harness.registry.createToolForCategory('unknown', 'snapshot')).rejects.toThrow('Tool unknown/snapshot not registered');
  });
});
