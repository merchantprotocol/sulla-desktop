// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ref } from 'vue';

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import {
  emptyTypography, sanitizeTypography, typographyCssVars, typographyFlagClass,
  TYPOGRAPHY_SETTING_KEY, TYPOGRAPHY_STORAGE_KEY, type TypographySettings,
} from '@pkg/config/typography';

// Shared across every caller in this window.
const typography = ref<TypographySettings>(emptyTypography());
let applied: string[] = [];
let started = false;

function readLocal(): TypographySettings | null {
  try {
    const stored = localStorage.getItem(TYPOGRAPHY_STORAGE_KEY);

    return stored === null ? null : sanitizeTypography(stored);
  } catch {
    return null;
  }
}

/** Writes the set fields as `--type-*` variables on <html> and removes stale ones. */
export function applyTypography(settings: TypographySettings, root: HTMLElement = document.documentElement): void {
  const vars = typographyCssVars(settings);

  for (const name of applied) {
    if (!(name in vars)) {
      root.style.removeProperty(name);
      root.classList.remove(typographyFlagClass(name));
    }
  }
  for (const [name, value] of Object.entries(vars)) {
    root.style.setProperty(name, value);
    root.classList.add(typographyFlagClass(name));
  }
  applied = Object.keys(vars);
}

function show(settings: TypographySettings): void {
  typography.value = settings;
  applyTypography(settings);
}

/**
 * Loads saved typography once per window and follows changes made in other
 * windows (the Preferences tab writes localStorage, which fires `storage`).
 */
export function startTypography(): void {
  if (started || typeof window === 'undefined') return;
  started = true;

  const local = readLocal();

  if (local) show(local);
  window.addEventListener('storage', (event) => {
    if (event.key === TYPOGRAPHY_STORAGE_KEY) show(sanitizeTypography(event.newValue));
  });
  SullaSettingsModel.get(TYPOGRAPHY_SETTING_KEY, null)
    .then((saved) => {
      if (saved !== null) show(sanitizeTypography(saved));
    })
    .catch(() => undefined);
}

export function useTypography() {
  startTypography();

  function setTypography(next: TypographySettings): void {
    const clean = sanitizeTypography(next);

    show(clean);
    try {
      localStorage.setItem(TYPOGRAPHY_STORAGE_KEY, JSON.stringify(clean));
    } catch {
      // Storage blocked: the settings write below still persists it.
    }
    SullaSettingsModel.set(TYPOGRAPHY_SETTING_KEY, clean, 'json').catch(() => undefined);
  }

  return { typography, setTypography };
}
