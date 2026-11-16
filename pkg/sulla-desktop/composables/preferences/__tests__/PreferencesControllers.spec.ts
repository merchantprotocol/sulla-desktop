// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Characterization specs for the E18-S2 preferences controllers: the logic
// moved out of the useXxx() closures must behave exactly as before.
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcRenderer: { invoke: vi.fn(), send: vi.fn(), on: vi.fn(), removeListener: vi.fn() } }));
vi.mock('vuex', () => ({ useStore: vi.fn() }));
vi.mock('@pkg/agent/database/models/SullaSettingsModel', () => ({ SullaSettingsModel: { get: vi.fn(), set: vi.fn() } }));

import { EngineSettingsController, EngineSettingsState, type EngineSettingsStore } from '../useEngineSettings';
import { ModelSettingsController } from '../useModelSettings';
import { PromptDiff, PromptSectionsController } from '../usePromptSections';
import { FactoryResetService } from '../resets';
import { SullaSettingController } from '../useSullaSetting';

class FakePreferencesStore implements EngineSettingsStore {
  getters: Record<string, any>;
  state = { preferences: { preferencesError: '', initialPreferences: { a: 1 } } };
  prefs: Record<string, any> = { a: 1 };
  severities: Record<string, boolean> = {};
  commits = 0;

  constructor() {
    this.getters = {
      'preferences/isPreferenceLocked': () => false,
    };
    Object.defineProperty(this.getters, 'preferences/getPreferences', { get: () => this.prefs });
  }

  async dispatch(type: string, payload?: unknown): Promise<any> {
    if (type === 'preferences/setPreferences') {
      this.prefs = payload as Record<string, any>;
    } else if (type === 'preferences/proposePreferences') {
      return this.severities;
    } else if (type === 'preferences/commitPreferences') {
      this.commits++;
    }
  }
}

function engine(store: FakePreferencesStore, response = 0) {
  const ipc = { invoke: vi.fn().mockResolvedValue({ response }) };

  return { controller: new EngineSettingsController(store, ipc, new EngineSettingsState()), ipc };
}

describe('EngineSettingsController', () => {
  // risk: data accuracy — non-restarting changes are committed immediately
  it('commits a change that needs no restart', async() => {
    const store = new FakePreferencesStore();
    const { controller } = engine(store);

    await controller.set('a', 2);

    expect(store.prefs.a).toBe(2);
    expect(store.commits).toBe(1);
    expect(controller.held.value).toBeNull();
  });

  // risk: irreversible side effect — a VM reset must be held and confirmed, never auto-applied
  it('holds a reset change and only commits after the user confirms', async() => {
    const store = new FakePreferencesStore();
    const { controller, ipc } = engine(store, 1);

    store.severities = { reset: true };
    await controller.set('a', 3);
    expect(store.commits).toBe(0);
    expect(controller.held.value).toBe('reset');

    await controller.applyHeld(); // user pressed Cancel
    expect(ipc.invoke).toHaveBeenCalledWith('show-message-box', expect.anything());
    expect(store.commits).toBe(0);
    expect(controller.held.value).toBe('reset');
  });

  // risk: data accuracy — an invalid value is rolled back and reported
  it('restores the old values when the change is invalid', async() => {
    const store = new FakePreferencesStore();
    const { controller } = engine(store);

    store.severities = { error: true };
    await controller.set('a', 9);

    expect(store.prefs.a).toBe(1);
    expect(controller.error.value).toBe('Sulla could not accept that value.');
    expect(store.commits).toBe(0);
  });
});

describe('SullaSettingController', () => {
  // risk: data accuracy — failed saves must not look saved
  it('reverts the value when saving fails', async() => {
    const settings = { get: vi.fn().mockResolvedValue('7'), set: vi.fn().mockRejectedValue(new Error('down')) };
    const controller = new SullaSettingController<number>('k', 1, 'number', settings);

    await controller.reload();
    expect(controller.value.value).toBe(7);

    await controller.save(8);
    expect(controller.value.value).toBe(7);
    expect(controller.error.value).toBe('Could not save this setting: down');
  });

  it('coerces empty and invalid stored values to the fallback', () => {
    const controller = new SullaSettingController<number>('k', 5, 'number', { get: vi.fn(), set: vi.fn() });

    expect(controller.coerce('')).toBe(5);
    expect(controller.coerce('abc')).toBe(5);
    expect(new SullaSettingController<boolean>('b', false, 'boolean', { get: vi.fn(), set: vi.fn() }).coerce('true')).toBe(true);
  });
});

describe('PromptSectionsController', () => {
  // risk: data accuracy — saving a section deleted elsewhere must say so, not look saved
  it('reloads and reports when the saved section no longer exists', async() => {
    const ipc = { invoke: vi.fn(async(channel: string) => (channel === 'system-prompt:update' ? null : [])) };
    const controller = new PromptSectionsController(ipc);

    await controller.save('soul', 'x');

    expect(ipc.invoke).toHaveBeenCalledWith('system-prompt:list');
    expect(controller.error.value).toBe('Could not save: this section no longer exists.');
  });

  // risk: permissions — built-in sections can never be deleted
  it('refuses to remove a built-in section', async() => {
    const ipc = { invoke: vi.fn() };
    const controller = new PromptSectionsController(ipc);

    await controller.remove({ id: 'soul', is_builtin: true } as any);

    expect(ipc.invoke).not.toHaveBeenCalled();
  });

  it('diffs base and proposed text line by line', () => {
    expect(PromptDiff.lines('a\nb', 'a\nc')).toEqual([
      { type: 'ctx', text: 'a' },
      { type: 'del', text: 'b' },
      { type: 'add', text: 'c' },
    ]);
  });
});

describe('ModelSettingsController', () => {
  // risk: data accuracy — a disconnected saved provider must not stay selected
  it('points slots at a connected provider when the saved one is disconnected', async() => {
    const ipc = {
      invoke: vi.fn(async(channel: string) => (channel === 'model-provider:get-providers'
        ? [{ id: 'openai', name: 'OpenAI', connected: true }, { id: 'gone', name: 'Gone', connected: false }]
        : [])),
      on:             vi.fn(),
      removeListener: vi.fn(),
    };
    const controller = new ModelSettingsController(ipc, { addEventListener: vi.fn(), removeEventListener: vi.fn() });

    controller.applyState({ primaryProvider: 'gone', secondaryProvider: 'gone', subconsciousProvider: 'gone' });
    await controller.loadProviders();

    expect(controller.providers.value.map(p => p.id)).toEqual(['openai']);
    expect(controller.state.primaryProvider).toBe('openai');
    expect(controller.state.secondaryProvider).toBe('openai');
    expect(controller.state.subconsciousProvider).toBe('default');
    controller.unmount();
  });
});

describe('FactoryResetService', () => {
  // risk: irreversible side effect — factory reset only runs after the user confirms
  it('does not reset when the user cancels', async() => {
    const ipc = { invoke: vi.fn().mockResolvedValue({ response: 1 }), send: vi.fn() };

    await new FactoryResetService(ipc).confirmFactoryReset();
    expect(ipc.send).not.toHaveBeenCalled();
  });

  it('resets and passes the keep-images choice when confirmed', async() => {
    const ipc = { invoke: vi.fn().mockResolvedValue({ response: 0, checkboxChecked: true }), send: vi.fn() };

    await new FactoryResetService(ipc).confirmFactoryReset();
    expect(ipc.send).toHaveBeenCalledWith('factory-reset', true);
  });
});
