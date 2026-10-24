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

export function useSullaSetting<T>(key: string, fallback: T, cast?: SettingCast, options: { refreshOnFocus?: boolean } = {}): SullaSetting<T> {
  const value = ref(fallback) as Ref<T>;
  const error = ref('');

  function coerce(raw: unknown): T {
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

  async function reload() {
    try {
      value.value = coerce(await SullaSettingsModel.get(key, fallback));
    } catch (err) {
      error.value = `Could not load this setting: ${ err instanceof Error ? err.message : String(err) }`;
    }
  }

  async function save(next: T) {
    const previous = value.value;

    value.value = next;
    error.value = '';
    try {
      await SullaSettingsModel.set(key, next, cast);
    } catch (err) {
      value.value = previous;
      error.value = `Could not save this setting: ${ err instanceof Error ? err.message : String(err) }`;
    }
  }

  void reload();

  if (options.refreshOnFocus) {
    window.addEventListener('focus', reload);
    onBeforeUnmount(() => window.removeEventListener('focus', reload));
  }

  return {
    value, error, save, reload,
  };
}
