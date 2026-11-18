import { describe, expect, it, vi } from 'vitest';

import { AgentPersonaRegistry } from './AgentPersonaRegistry';

// The registry imports '@pkg/agent', which re-exports the whole agent barrel. That graph reaches
// Electron, the logger (which mkdirSyncs its logs dir at import) and the first-run credential store
// at module load. None of that is exercised by the registry lifecycle, so stub it out here.
vi.mock('electron', () => ({
  app:     { getPath: () => '/tmp/persona-registry-spec', getVersion: () => '0.0.0', isPackaged: false },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
  session: { fromPartition: () => ({}) },
  shell:   { openExternal: vi.fn() },
}));
vi.mock('../../../utils/logging', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), log: vi.fn() },
}));
vi.mock('../../controllers/ToolExecutor', () => ({ ToolExecutor: class {} }));
vi.mock('../../../main/firstRun/pendingCredentials', () => ({
  getPendingCredential:    vi.fn(() => undefined),
  hasPendingCredential:    vi.fn(() => false),
  queuePendingCredential:  vi.fn(),
}));

// AgentPersonaModel calls getWebSocketClientService() at construction. The real service pulls in
// IpcMessageBusRenderer, which does not exist in the Node test graph, so swap in a plain stub.
// Methods used by AgentPersonaModel: connect, onMessage (returns an unsubscribe fn), send (resolves a boolean).
const { stubWs } = vi.hoisted(() => ({
  stubWs: {
    connect:   vi.fn(),
    onMessage: vi.fn(() => () => {}),
    send:      vi.fn(async () => true),
  },
}));
vi.mock('../../services/WebSocketClientService', () => ({
  getWebSocketClientService: () => stubWs,
}));

describe('AgentPersonaRegistry tab lifecycle', () => {
  it('stops listeners and removes the per-tab service so reopening creates fresh state', () => {
    // risk: renderer memory and duplicate websocket listeners after closing/reopening a chat
    const registry = new AgentPersonaRegistry();
    const first = registry.getOrCreatePersonaService('sulla-desktop', 'tab-closed');
    const stopListening = vi.spyOn(first, 'stopListening');

    expect(registry.release('sulla-desktop', 'tab-closed')).toBe(true);
    expect(stopListening).toHaveBeenCalledOnce();
    expect(registry.getOrCreatePersonaService('sulla-desktop', 'tab-closed')).not.toBe(first);
    expect(registry.release('sulla-desktop', 'missing')).toBe(false);
  });
});
