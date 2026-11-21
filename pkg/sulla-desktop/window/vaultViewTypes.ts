// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type Electron from 'electron';
import type { WebContentsView } from 'electron';

export interface VaultViewReservation {
  ownerId:    string;
  windowId:   number;
  generation: number;
}

export interface VaultTabHost {
  observeLayout(listener: (bounds: Electron.Rectangle | null, raised: boolean) => void): () => void;
  onDisposed(listener: () => void): (() => void) | null;
}

export interface VaultWindowState {
  view: WebContentsView | null;
  bounds: Electron.Rectangle | null;
  hostBounds: Electron.Rectangle | null | undefined;
  hostCleanup: (() => void) | null;
  attached: boolean;
  ready: boolean;
  isolatedSession: Electron.Session | null;
  ownerId: string | null;
  attachedOwnerId: string | null;
  generation: number;
  themeCss: string;
  themeKey: string | null;
  themeUpdate: Promise<void>;
  keepAliveTimer: ReturnType<typeof setTimeout> | null;
  expiryTimer: ReturnType<typeof setTimeout> | null;
  sessionExpiresAt: number | null;
  targetUrl: string | null;
  window: Electron.BrowserWindow;
}

export interface CreatedVaultView {
  view:    WebContentsView;
  session: Electron.Session;
}

export interface VaultOpenTimings {
  requestedAt: number;
  waitUntilStartedMs: number;
  createHumanSessionMs: number;
  createViewMs: number;
  onLoadURLComplete?: (durationMs: number) => void;
}
