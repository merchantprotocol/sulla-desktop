// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

const { ipcRenderer } = require('electron');

const PRIMARY_COLOR_SETTING_KEY = 'primaryColor';
const PRIMARY_COLOR_STORAGE_KEY = 'agentPrimaryColor';
const PRIMARY_COLOR_OVERRIDE_CLASS = 'has-primary-color-override';

/** Standalone tray windows mirror the renderer palette without a bundler import. */
class TrayPrimaryColorBridge {
  constructor(root, ipc) {
    this.root = root;
    this.ipc = ipc;
    this.applied = [];
    this.color = null;
    this.mode = 'dark';
  }

  sanitize(value) {
    return typeof value === 'string' && /^#[\da-f]{6}$/i.test(value.trim())
      ? value.trim().toLowerCase()
      : null;
  }

  channels(value) {
    return [1, 3, 5].map(index => Number.parseInt(value.slice(index, index + 2), 16));
  }

  toHex(value) {
    return Math.min(255, Math.max(0, Math.round(value))).toString(16).padStart(2, '0');
  }

  mix(value, target, amount) {
    const [red, green, blue] = this.channels(value);
    const [targetRed, targetGreen, targetBlue] = this.channels(target);
    return `#${ [red, green, blue].map((channel, index) => this.toHex(channel * (1 - amount) + [targetRed, targetGreen, targetBlue][index] * amount)).join('') }`;
  }

  luminance(value) {
    const color = this.sanitize(value);
    if (!color) return null;
    const channels = this.channels(color).map(channel => {
      const srgb = channel / 255;
      return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  }

  contrast(first, second) {
    const firstLuminance = this.luminance(first);
    const secondLuminance = this.luminance(second);
    if (firstLuminance === null || secondLuminance === null) return 0;
    return (Math.max(firstLuminance, secondLuminance) + 0.05) / (Math.min(firstLuminance, secondLuminance) + 0.05);
  }

  readableText(value) {
    return this.contrast('#000000', value) >= this.contrast('#ffffff', value) ? '#000000' : '#ffffff';
  }

  ensureDarkSurfaceContrast(value) {
    const darkSurface = '#2e3440';
    let amount = 0;
    let result = value;
    while (this.contrast(result, darkSurface) < 3 && amount < 1) {
      amount = Math.min(1, amount + 0.05);
      result = this.mix(value, '#ffffff', amount);
    }
    return result;
  }

  palette(value) {
    const selected = this.sanitize(value);
    if (!selected) return {};

    const primary = this.mode === 'dark'
      ? this.ensureDarkSurfaceContrast(this.mix(selected, '#ffffff', 0.38))
      : selected;
    const hover = this.mode === 'dark'
      ? this.ensureDarkSurfaceContrast(this.mix(selected, '#ffffff', 0.50))
      : this.mix(primary, '#000000', 0.13);
    const onPrimary = this.readableText(primary);
    const onHover = this.readableText(hover);
    const tint = `color-mix(in srgb, ${ primary } 12%, transparent)`;
    const border = `color-mix(in srgb, ${ primary } 44%, transparent)`;
    const ring = `color-mix(in srgb, ${ primary } 38%, transparent)`;

    return {
      '--accent-primary': primary,
      '--accent-primary-hover': hover,
      '--accent': primary,
      '--accent-2': hover,
      '--accent-hover': hover,
      '--accent-dim': tint,
      '--accent-soft': tint,
      '--accent-line': border,
      '--accent-border': border,
      '--border-accent': border,
      '--border-focus': border,
      '--text-on-accent': onPrimary,
      '--text-on-accent-hover': onHover,
      '--on-accent': onPrimary,
      '--on-accent-hover': onHover,
      '--text-accent': primary,
      '--text-link': primary,
      '--bg-accent': tint,
      '--brand-glow': ring,
      '--brand-glow-soft': `color-mix(in srgb, ${ primary } 15%, transparent)`,
      '--brand-glow-strong': `color-mix(in srgb, ${ primary } 58%, transparent)`,
      '--accent-glow': ring,
      '--ring-color': ring,
      '--nx-accent': primary,
      '--nx-accent-2': hover,
      '--nx-glow': ring,
      '--nx-indicator-edge': border,
      '--primary-btn-bg': primary,
      '--primary-btn-hover-bg': hover,
      '--primary-btn-text': onPrimary,
      '--primary-btn-hover-text': onHover,
      '--primary': primary,
      '--primary-hover': hover,
      '--accent-btn': tint,
      '--accent-btn-hover': hover,
      '--accent-btn-hover-text': onHover,
      '--outline': primary,
      '--checkbox-ticked-bg': primary,
      '--dropdown-text': primary,
      '--dropdown-hover-bg': hover,
      '--terminal-cursor': primary,
      '--terminal-selection': border,
      '--sx-color-primary': primary,
      '--sx-color-surface-tint': tint,
    };
  }

  setTheme(theme) {
    const normalized = typeof theme === 'string' ? theme.toLowerCase() : '';
    this.mode = normalized === 'light' || normalized.endsWith('-light') ? 'light' : 'dark';
    this.apply(this.color);
  }

  start() {
    try {
      this.color = this.sanitize(localStorage.getItem(PRIMARY_COLOR_STORAGE_KEY));
      const localTheme = localStorage.getItem('agentTheme');
      if (localTheme) this.setTheme(localTheme);
    } catch {
      // The IPC-backed settings reads below remain the durable fallback.
    }
    this.apply(this.color);
    this.ipc.invoke('sulla-settings-get', PRIMARY_COLOR_SETTING_KEY, null)
      .then(value => {
        if (this.color === null) this.color = this.sanitize(value);
        this.apply(this.color);
      })
      .catch(() => undefined);
    this.ipc.invoke('sulla-settings-get', 'theme', 'noir-dark')
      .then(theme => this.setTheme(theme))
      .catch(() => undefined);
    this.ipc.on('sulla:primary-color-changed', (_event, value) => {
      this.color = this.sanitize(value);
      this.apply(this.color);
    });
    this.ipc.on('sulla:theme-changed', (_event, theme) => this.setTheme(theme));
  }

  apply(value) {
    const vars = this.palette(value);
    for (const name of this.applied) {
      if (!(name in vars)) this.root.style.removeProperty(name);
    }
    for (const [name, cssValue] of Object.entries(vars)) this.root.style.setProperty(name, cssValue, 'important');
    this.root.classList.toggle(PRIMARY_COLOR_OVERRIDE_CLASS, Object.keys(vars).length > 0);
    this.applied = Object.keys(vars);
  }
}

new TrayPrimaryColorBridge(document.documentElement, ipcRenderer).start();
