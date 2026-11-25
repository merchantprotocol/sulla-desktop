// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ref, type Ref } from 'vue';

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import {
  PRIMARY_COLOR_OVERRIDE_CLASS, PRIMARY_COLOR_SETTING_KEY, PRIMARY_COLOR_STORAGE_KEY,
  primaryColorCssVars, sanitizePrimaryColor, type PrimaryColorMode,
} from '@pkg/config/primaryColor';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

type PrimaryColorSettings = Pick<typeof SullaSettingsModel, 'get' | 'set' | 'delete'>;
type PrimaryColorIpc = Pick<typeof ipcRenderer, 'on'>;

/** Per-window primary-color preference store. Receivers never persist broadcasts. */
export class PrimaryColorStore {
  private static instance: PrimaryColorStore | undefined;

  static shared(): PrimaryColorStore {
    PrimaryColorStore.instance ??= new PrimaryColorStore(SullaSettingsModel, ipcRenderer);

    return PrimaryColorStore.instance;
  }

  readonly primaryColor: Ref<string | null> = ref<string | null>(null);
  private applied: string[] = [];
  private started = false;
  private mode: PrimaryColorMode = 'light';

  constructor(
    private readonly settings: PrimaryColorSettings,
    private readonly ipc: PrimaryColorIpc,
  ) {}

  /** Writes only custom values; removing them restores the theme's untouched defaults. */
  apply(value: unknown, root: HTMLElement = document.documentElement, mode: PrimaryColorMode = this.mode): void {
    const color = sanitizePrimaryColor(value);
    const vars = primaryColorCssVars(color, mode);

    for (const name of this.applied) {
      if (!(name in vars)) root.style.removeProperty(name);
    }
    for (const [name, cssValue] of Object.entries(vars)) root.style.setProperty(name, cssValue, 'important');
    root.classList.toggle(PRIMARY_COLOR_OVERRIDE_CLASS, color !== null);
    this.applied = Object.keys(vars);
  }

  /** Load the synchronous local mirror first, then use the database only if absent. */
  start(mode: PrimaryColorMode = this.mode): void {
    this.mode = mode;
    if (this.started || typeof window === 'undefined') {
      this.apply(this.primaryColor.value);
      return;
    }
    this.started = true;

    const local = this.readLocal();
    if (local !== undefined) this.show(local);

    window.addEventListener('storage', (event) => {
      if (event.key !== PRIMARY_COLOR_STORAGE_KEY) return;
      if (event.newValue === null) {
        this.show(null);
        return;
      }
      const color = sanitizePrimaryColor(event.newValue);
      if (color) this.show(color);
    });
    this.ipc.on('sulla:primary-color-changed', (_event, value) => {
      if (value === null) {
        this.show(null);
        return;
      }
      const color = sanitizePrimaryColor(value);
      if (color) this.show(color);
    });

    this.settings.get(PRIMARY_COLOR_SETTING_KEY, null)
      .then(saved => {
        const color = sanitizePrimaryColor(saved);
        if (color && local === undefined) this.show(color);
      })
      .catch(() => undefined);
  }

  /** Re-derive the same selected color when the active theme switches mode. */
  setMode(mode: PrimaryColorMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.apply(this.primaryColor.value);
  }

  /** Invalid input is ignored; valid input applies and mirrors before persistence. */
  set(value: unknown): void {
    const color = sanitizePrimaryColor(value);
    if (!color) return;

    this.show(color);
    try {
      localStorage.setItem(PRIMARY_COLOR_STORAGE_KEY, color);
    } catch {
      // The settings model remains the durable fallback when local storage is unavailable.
    }
    this.settings.set(PRIMARY_COLOR_SETTING_KEY, color, 'string').catch(() => undefined);
  }

  /** Remove, rather than store a sentinel, so the active theme becomes authoritative. */
  reset(): void {
    this.show(null);
    try {
      localStorage.removeItem(PRIMARY_COLOR_STORAGE_KEY);
    } catch {
      // The settings delete below remains authoritative.
    }
    this.settings.delete(PRIMARY_COLOR_SETTING_KEY).catch(() => undefined);
  }

  private readLocal(): string | undefined {
    try {
      const stored = localStorage.getItem(PRIMARY_COLOR_STORAGE_KEY);

      return stored === null ? undefined : sanitizePrimaryColor(stored) ?? undefined;
    } catch {
      return undefined;
    }
  }

  private show(value: string | null): void {
    this.primaryColor.value = value;
    this.apply(value);
  }
}

export function startPrimaryColor(mode: PrimaryColorMode = 'light'): void {
  PrimaryColorStore.shared().start(mode);
}

export function setPrimaryColorMode(mode: PrimaryColorMode): void {
  PrimaryColorStore.shared().setMode(mode);
}

export function usePrimaryColor() {
  const store = PrimaryColorStore.shared();
  store.start();

  return {
    primaryColor: store.primaryColor,
    setPrimaryColor: (value: unknown) => store.set(value),
    resetPrimaryColor: () => store.reset(),
  };
}
