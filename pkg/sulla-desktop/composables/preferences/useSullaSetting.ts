// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * One Sulla setting (the agent-side settings table), loaded once and saved the
 * moment it changes. Other windows and the phone can change these too, so
 * `reload` re-reads it when the window regains focus.
 */
import { onBeforeUnmount, ref, type Ref } from 'vue';

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';

export type SettingCast = 'string' | 'number' | 'boolean';

export interface SullaSetting<T> {
  value:  Ref<T>;
  error:  Ref<string>;
  save:   (next: T) => Promise<void>;
  reload: () => Promise<void>;
}

/** Where a Sulla setting is read from and written to (swappable in tests). */
export interface SullaSettingsStore {
  get(key: string, fallback: unknown): Promise<unknown>;
  set(key: string, value: unknown, cast?: SettingCast): Promise<unknown>;
}

/** One Sulla setting: its current value, last error, and load/save. */
export class SullaSettingController<T> implements SullaSetting<T> {
  readonly value: Ref<T>;
  readonly error = ref('');

  constructor(
    private readonly key: string,
    private readonly fallback: T,
    private readonly cast: SettingCast | undefined,
    private readonly settingsStore: SullaSettingsStore,
  ) {
    this.value = ref(fallback) as Ref<T>;
  }

  /** Turn a stored value into this setting's type, falling back when empty or invalid. */
  coerce(raw: unknown): T {
    const { fallback, cast } = this;

    if (raw === null || raw === undefined || raw === '') {
      return fallback;
    }
    if (cast === 'number') {
      const n = Number(raw);

      return (Number.isFinite(n) ? n : fallback) as T;
    }
    if (cast === 'boolean') {
      return (raw === true || raw === 'true') as T;
    }

    return raw as T;
  }

  reload = async(): Promise<void> => {
    try {
      this.value.value = this.coerce(await this.settingsStore.get(this.key, this.fallback));
    } catch (err) {
      this.error.value = `Could not load this setting: ${ err instanceof Error ? err.message : String(err) }`;
    }
  };

  save = async(next: T): Promise<void> => {
    const previous = this.value.value;

    this.value.value = next;
    this.error.value = '';
    try {
      await this.settingsStore.set(this.key, next, this.cast);
    } catch (err) {
      this.value.value = previous;
      this.error.value = `Could not save this setting: ${ err instanceof Error ? err.message : String(err) }`;
    }
  };
}

/** Vue entry point: one Sulla setting, loaded now and optionally re-read on window focus. */
export function useSullaSetting<T>(
  key: string,
  fallback: T,
  cast?: SettingCast,
  options: { refreshOnFocus?: boolean } = {},
): SullaSetting<T> {
  const controller = new SullaSettingController<T>(key, fallback, cast, SullaSettingsModel as unknown as SullaSettingsStore);
  const {
    value, error, save, reload,
  } = controller;

  void reload();

  if (options.refreshOnFocus) {
    window.addEventListener('focus', reload);
    onBeforeUnmount(() => window.removeEventListener('focus', reload));
  }

  return {
    value, error, save, reload,
  };
}
