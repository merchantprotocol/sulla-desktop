// browserPermissions.ts — Chrome-style site permissions for browser tabs.
//
// With no handler installed, Electron grants EVERY permission request, so any
// website opened in a Sulla tab could silently turn on the camera/microphone,
// read the clipboard or track location. This policy mirrors Chrome:
//   - harmless capabilities are allowed (fullscreen, pointer lock, DRM, …);
//   - sensitive ones prompt the user once per site and the answer is saved;
//   - everything else is denied.
// Requests from tabs the user can't see (parked agent tabs, hidden browsers)
// are denied without prompting — a dialog for a page nobody is looking at is
// both confusing and a stall for agent automation.

import fs from 'fs';
import path from 'path';

export type SitePermissionDecision = 'allow' | 'deny';

/** Granted without asking — Chrome allows these by default too. */
const ALWAYS_ALLOW = new Set([
  'fullscreen',
  'pointerLock',
  'clipboard-sanitized-write',
  'mediaKeySystem', // DRM (Netflix, Spotify)
  // Kept allowed: native notifications were always allowed here and the tab
  // preload relies on them. Electron's permission *check* API is boolean, so
  // an undecided notification permission can't be reported as "prompt".
  'notifications',
]);

/** Asked once per site; the answer is remembered. */
const PROMPTABLE: Record<string, string> = {
  media:                    'use your camera or microphone',
  geolocation:              'know your location',
  'clipboard-read':           'see text and images copied to the clipboard',
  'display-capture':          'share your screen',
  midi:                     'use your MIDI devices',
  midiSysex:                'get full control of your MIDI devices',
  'idle-detection':           'know when you are actively using this device',
  openExternal:             'open an external application',
  'storage-access':           'use cookies and site data from another site',
  'top-level-storage-access': 'use cookies and site data from another site',
  'window-management':        'manage windows on all your displays',
  'speaker-selection':        'choose your audio output devices',
  keyboardLock:             'take over your keyboard shortcuts',
};

/**
 * Store key. Camera and microphone are separate grants, like in Chrome, so a
 * site allowed the mic doesn't silently get the camera too.
 */
export function permissionKey(permission: string, details?: { mediaTypes?: string[] }): string {
  if (permission === 'media' && details?.mediaTypes?.length) {
    return `media:${ [...details.mediaTypes].sort().join('+') }`;
  }

  return permission;
}

export function describePermission(permission: string, details?: { mediaTypes?: string[] }): string {
  if (permission === 'media' && details?.mediaTypes?.length) {
    const types = details.mediaTypes;
    if (types.includes('video') && types.includes('audio')) return 'use your camera and microphone';
    if (types.includes('video')) return 'use your camera';
    if (types.includes('audio')) return 'use your microphone';
  }

  return PROMPTABLE[permission] ?? `use "${ permission }"`;
}

export function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);

    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

/** Per-origin decisions, persisted as JSON. */
export class SitePermissionStore {
  private decisions: Record<string, Record<string, SitePermissionDecision>> = {};
  private loaded = false;

  constructor(private readonly filePath: string | null) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.filePath) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      if (parsed && typeof parsed === 'object') this.decisions = parsed;
    } catch { /* first run or unreadable — start empty */ }
  }

  get(origin: string, key: string): SitePermissionDecision | undefined {
    this.load();

    return this.decisions[origin]?.[key];
  }

  set(origin: string, key: string, decision: SitePermissionDecision): void {
    this.load();
    (this.decisions[origin] ??= {})[key] = decision;
    if (!this.filePath) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.decisions, null, 2), { mode: 0o600 });
    } catch (err) {
      console.warn('[BrowserPermissions] could not save site permissions:', err);
    }
  }
}

export interface PermissionRequest {
  permission:   string;
  origin:       string | null;
  details?:     { mediaTypes?: string[] };
  /** Whether the requesting page is on screen right now (focused tab / popup). */
  userVisible:  boolean;
}

export type PromptFn = (origin: string, description: string) => Promise<boolean>;

export class BrowserPermissionPolicy {
  private readonly inFlight = new Map<string, Promise<boolean>>();

  constructor(private readonly store: SitePermissionStore, private readonly prompt: PromptFn) {}

  /** Synchronous permission *check* (navigator.permissions, Notification.permission). */
  check(permission: string, origin: string | null, details?: { mediaTypes?: string[] }): boolean {
    if (ALWAYS_ALLOW.has(permission)) return true;
    if (!origin || !(permission in PROMPTABLE)) return false;

    return this.store.get(origin, permissionKey(permission, details)) === 'allow';
  }

  /** Asynchronous permission *request* (getUserMedia, geolocation, …). */
  async request(req: PermissionRequest): Promise<boolean> {
    const { permission, origin, details } = req;
    if (ALWAYS_ALLOW.has(permission)) return true;
    if (!origin || !(permission in PROMPTABLE)) return false;

    const key = permissionKey(permission, details);
    const saved = this.store.get(origin, key);
    if (saved) return saved === 'allow';
    // Never pop a dialog for a page the user can't see; don't remember it
    // either, so the site can ask again once the user is looking at it.
    if (!req.userVisible) return false;

    const flightKey = `${ origin }|${ key }`;
    const pending = this.inFlight.get(flightKey);
    if (pending) return pending;

    const decision = this.prompt(origin, describePermission(permission, details))
      .catch(() => false)
      .then((allowed) => {
        this.store.set(origin, key, allowed ? 'allow' : 'deny');

        return allowed;
      })
      .finally(() => this.inFlight.delete(flightKey));
    this.inFlight.set(flightKey, decision);

    return decision;
  }
}
