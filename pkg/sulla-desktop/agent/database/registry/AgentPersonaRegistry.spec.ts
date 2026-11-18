import { describe, expect, it, vi } from 'vitest';

import { AgentPersonaRegistry } from './AgentPersonaRegistry';

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
