// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Engine settings (the `Settings` object behind Docker and the
 * app's own switches), read and written through the existing preferences
 * store and command server.
 *
 * Changes that don't restart anything are saved as soon as they're made.
 * Changes that restart Docker or reset the virtual machine are held, and the tab
 * shows a bar to apply or discard them.
 */
import _ from 'lodash';
import {
  computed, ref, type ComputedRef, type Ref,
} from 'vue';
import { useStore } from 'vuex';

import type { Settings } from '@pkg/config/settings';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import { decideApply } from '@pkg/utils/preferencesModel';

type Held = 'restart' | 'reset';

/** The slice of the renderer IPC the controller needs (swappable in tests). */
export interface EngineSettingsIpc {
  invoke(channel: string, ...args: any[]): Promise<any>;
}

/** The parts of the Vuex store the controller reads and dispatches to. */
export interface EngineSettingsStore {
  getters:  Record<string, any>;
  state:    any;
  dispatch(type: string, payload?: unknown): Promise<any>;
}

/**
 * The held-changes bar state. One Preferences tab per window, so a single
 * instance is shared by every section.
 */
export class EngineSettingsState {
  private static instance: EngineSettingsState | undefined;

  static get shared(): EngineSettingsState {
    EngineSettingsState.instance ??= new EngineSettingsState();

    return EngineSettingsState.instance;
  }

  readonly held = ref<Held | null>(null);
  readonly error = ref('');
  readonly applying = ref(false);
}

/** Reads, saves, holds and applies engine settings through the preferences store. */
export class EngineSettingsController {
  readonly settings: ComputedRef<Settings>;
  readonly held: Ref<Held | null>;
  readonly error: Ref<string>;
  readonly applying: Ref<boolean>;

  constructor(
    private readonly store: EngineSettingsStore,
    private readonly ipc: EngineSettingsIpc,
    shared: EngineSettingsState,
  ) {
    this.settings = computed<Settings>(() => store.getters['preferences/getPreferences']);
    this.held = shared.held;
    this.error = shared.error;
    this.applying = shared.applying;
  }

  get = <T = any>(path: string): T => {
    return _.get(this.settings.value, path) as T;
  };

  isLocked = (path: string): boolean => {
    return !!this.store.getters['preferences/isPreferenceLocked'](path);
  };

  /** Change several settings at once, so linked choices are checked together. */
  setMany = async(changes: Record<string, unknown>): Promise<void> => {
    const { store, held, error } = this;
    const before = _.cloneDeep(this.settings.value);
    const next = _.cloneDeep(this.settings.value);

    for (const [path, value] of Object.entries(changes)) {
      _.set(next, path, value);
    }
    error.value = '';
    try {
      await store.dispatch('preferences/setPreferences', next);

      const decision = decideApply(await store.dispatch('preferences/proposePreferences'));

      if (decision === 'invalid') {
        error.value = store.state.preferences.preferencesError || 'Sulla could not accept that value.';
        // Put the old values back so the screen shows what's actually saved.
        await store.dispatch('preferences/setPreferences', before);

        return;
      }
      if (decision === 'apply' && !held.value) {
        await store.dispatch('preferences/commitPreferences');

        return;
      }
      // Restarting changes are held. Anything changed while they're held joins them.
      held.value = decision === 'reset' || held.value === 'reset' ? 'reset' : 'restart';
    } catch (err) {
      // Never fail silently: put the old values back and say why.
      await store.dispatch('preferences/setPreferences', before).catch(() => undefined);
      error.value = `Sulla could not save this setting: ${ err instanceof Error ? err.message : String(err) }`;
    }
  };

  set = (path: string, value: unknown): Promise<void> => {
    return this.setMany({ [path]: value });
  };

  applyHeld = async(): Promise<void> => {
    const { held, applying, error } = this;

    if (!held.value || applying.value) {
      return;
    }
    if (held.value === 'reset') {
      const cancelId = 1;
      const result = await this.ipc.invoke('show-message-box', {
        title:    'Sulla Desktop - Reset',
        type:     'warning',
        message:  'Apply these changes and reset the virtual machine?',
        detail:   'The virtual machine starts over. Its data is deleted.',
        cancelId,
        buttons:  ['Apply and reset', 'Cancel'],
      });

      if (result.response === cancelId) {
        return;
      }
    }
    applying.value = true;
    try {
      await this.store.dispatch('preferences/commitPreferences');
      held.value = null;
    } catch (err) {
      error.value = `Sulla could not save these settings: ${ err instanceof Error ? err.message : String(err) }`;
    } finally {
      applying.value = false;
    }
  };

  discardHeld = async(): Promise<void> => {
    await this.store.dispatch('preferences/setPreferences', this.store.state.preferences.initialPreferences);
    this.held.value = null;
    this.error.value = '';
  };
}

/** Vue entry point: the engine settings for this window's Preferences tab. */
export function useEngineSettings() {
  const controller = new EngineSettingsController(
    useStore() as unknown as EngineSettingsStore,
    ipcRenderer as unknown as EngineSettingsIpc,
    EngineSettingsState.shared,
  );
  const {
    settings, get, set, setMany, isLocked, held, error, applying, applyHeld, discardHeld,
  } = controller;

  return {
    settings, get, set, setMany, isLocked, held, error, applying, applyHeld, discardHeld,
  };
}
