// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ref, type Ref } from 'vue';

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import {
  emptyTypography, sanitizeTypography, typographyCssVars, typographyFlagClass,
  TYPOGRAPHY_SETTING_KEY, TYPOGRAPHY_STORAGE_KEY, type TypographySettings,
} from '@pkg/config/typography';

/** Typography settings for this window: one shared instance via TypographyStore.shared(). */
export class TypographyStore {
  private static instance: TypographyStore | undefined;

  static shared(): TypographyStore {
    TypographyStore.instance ??= new TypographyStore();

    return TypographyStore.instance;
  }

  readonly typography: Ref<TypographySettings> = ref<TypographySettings>(emptyTypography());
  private applied: string[] = [];
  private started = false;

  /** Writes the set fields as `--type-*` variables on <html> and removes stale ones. */
  apply(settings: TypographySettings, root: HTMLElement = document.documentElement): void {
    const vars = typographyCssVars(settings);

    for (const name of this.applied) {
      if (!(name in vars)) {
        root.style.removeProperty(name);
        root.classList.remove(typographyFlagClass(name));
      }
    }
    for (const [name, value] of Object.entries(vars)) {
      root.style.setProperty(name, value);
      root.classList.add(typographyFlagClass(name));
    }
    this.applied = Object.keys(vars);
  }

  /**
   * Loads saved typography once per window and follows changes made in other
   * windows (the Preferences tab writes localStorage, which fires `storage`).
   */
  start(): void {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;

    const local = this.readLocal();

    if (local) this.show(local);
    window.addEventListener('storage', (event) => {
      if (event.key === TYPOGRAPHY_STORAGE_KEY) this.show(sanitizeTypography(event.newValue));
    });
    SullaSettingsModel.get(TYPOGRAPHY_SETTING_KEY, null)
      .then((saved) => {
        if (saved !== null) this.show(sanitizeTypography(saved));
      })
      .catch(() => undefined);
  }

  set(next: TypographySettings): void {
    const clean = sanitizeTypography(next);

    this.show(clean);
    try {
      localStorage.setItem(TYPOGRAPHY_STORAGE_KEY, JSON.stringify(clean));
    } catch {
      // Storage blocked: the settings write below still persists it.
    }
    SullaSettingsModel.set(TYPOGRAPHY_SETTING_KEY, clean, 'json').catch(() => undefined);
  }

  private readLocal(): TypographySettings | null {
    try {
      const stored = localStorage.getItem(TYPOGRAPHY_STORAGE_KEY);

      return stored === null ? null : sanitizeTypography(stored);
    } catch {
      return null;
    }
  }

  private show(settings: TypographySettings): void {
    this.typography.value = settings;
    this.apply(settings);
  }
}

/** @deprecated use TypographyStore.shared().apply */
export const applyTypography = (settings: TypographySettings, root?: HTMLElement): void =>
  TypographyStore.shared().apply(settings, root);

/** @deprecated use TypographyStore.shared().start */
export const startTypography = (): void => TypographyStore.shared().start();

export function useTypography() {
  const store = TypographyStore.shared();

  store.start();

  return { typography: store.typography, setTypography: (next: TypographySettings) => store.set(next) };
}
