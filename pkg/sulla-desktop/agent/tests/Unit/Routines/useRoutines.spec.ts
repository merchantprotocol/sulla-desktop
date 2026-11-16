// SPDX-License-Identifier: GPL-2.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { invoke } }));
vi.mock('@pkg/composables/useDatabaseAvailableReload', () => ({
  useDatabaseAvailableReload: vi.fn(),
}));

import { useRoutines } from '@pkg/composables/useRoutines';

describe('archive/restore feedback', () => {
  beforeEach(() => invoke.mockReset());

  async function controller(status = 'draft') {
    invoke.mockResolvedValueOnce([{ id: 'workflow-1', name: 'Example', status, updatedAt: new Date().toISOString(), nodeCount: 1 }]);
    const model = useRoutines();
    await model.load();

    return model;
  }

  it.each(['draft', 'archive'])('refreshes after a successful move from %s', async(status) => {
    const model = await controller(status);
    invoke.mockResolvedValueOnce({ success: true }).mockResolvedValueOnce([]);
    expect(await model.toggleArchive('workflow-1')).toBe(true);
    expect(invoke).toHaveBeenCalledWith('workflow-move', 'workflow-1', status === 'archive' ? 'draft' : 'archive');
    expect(model.error.value).toBeNull();
  });

  it('does not announce success when the handler declines the move', async() => {
    const model = await controller();
    invoke.mockResolvedValueOnce({ success: false });
    expect(await model.toggleArchive('workflow-1')).toBe(false);
    expect(model.error.value).toBe('The workflow status did not change');
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('preserves a refresh failure instead of announcing success', async() => {
    const model = await controller();
    invoke.mockResolvedValueOnce({ success: true }).mockRejectedValueOnce(new Error('database unavailable'));
    expect(await model.toggleArchive('workflow-1')).toBe(false);
    expect(model.error.value).toBe('database unavailable');
  });

  it('reports rejected move requests', async() => {
    const model = await controller();
    invoke.mockRejectedValueOnce(new Error('move unavailable'));
    expect(await model.toggleArchive('workflow-1')).toBe(false);
    expect(model.error.value).toBe('move unavailable');
  });

  it('does not invoke IPC for a missing workflow', async() => {
    const model = await controller();
    expect(await model.toggleArchive('missing')).toBe(false);
    expect(model.error.value).toBe('Workflow not found: missing');
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
