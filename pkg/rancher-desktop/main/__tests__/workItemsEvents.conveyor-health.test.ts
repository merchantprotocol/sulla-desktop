import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

describe('work-items conveyor-health IPC contract', () => {
  const source = fs.readFileSync(path.resolve(process.cwd(), 'pkg/rancher-desktop/main/workItemsEvents.ts'), 'utf8');

  it('registers snapshot and bounded drill-down channels', () => {
    expect(source).toContain("handle('work-items:conveyor-health'");
    expect(source).toContain("handle('work-items:conveyor-oldest'");
    expect(source).toContain('WorkConveyorMetricsModel.snapshot');
    expect(source).toContain('WorkConveyorMetricsModel.oldestItems');
  });

  it('uses durable configured execution and review capacity', () => {
    expect(source).toContain('resolveWipLimits');
    expect(source).toContain('wipLimit: limits.execution');
    expect(source).toContain('reviewLimit: limits.review');
  });
});
