// SPDX-License-Identifier: GPL-2.0-or-later
import '../../Support/TestHomeEnv';
import { describe, expect, it, vi } from 'vitest';

import { createCodexService } from '@pkg/agent/languagemodels/CodexService';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => 'test', isPackaged: false }, safeStorage: {} }));

describe('Codex worker command effort', () => {
  it('passes max on both container and VM commands, including resumed sessions', () => {
    const service = createCodexService('gpt-6-luna', 'max') as any;
    expect(service.getEffort()).toBe('max');
    for (const existingSession of [undefined, 'existing-session']) {
      const command = service.buildProviderCommand({ existingSession });
      expect(command.args).toContain('gpt-6-luna');
      expect(command.args).toContain('model_reasoning_effort="max"');
      const vm = service.buildSpawnArgs({ existingSession, pidFile: '/tmp/qa-effort.pid' }).join(' ');
      expect(vm).toContain('model_reasoning_effort="max"');
    }
  });
  it('does not leak an explicit job effort into a fresh default worker', () => {
    const max = createCodexService('gpt-6-luna', 'max') as any;
    const normal = createCodexService('gpt-6-luna') as any;
    expect(normal.getEffort()).toBe('');
    expect(max.buildProviderCommand({}).args.join(' ')).toContain('model_reasoning_effort');
    expect(normal.buildProviderCommand({}).args.join(' ')).not.toContain('model_reasoning_effort');
    expect(normal.buildSpawnArgs({ pidFile: '/tmp/qa-default.pid' }).join(' ')).not.toContain('model_reasoning_effort');
  });
});
