/**
 * UpdateManager — centralized owner of the update lifecycle.
 *
 * Wraps the existing `setupUpdate()` / electron-updater plumbing in `index.ts`
 * and exposes a unified state model, IPC surface, and window-routing so every
 * entry point (tray, app menu, preferences, startup) funnels through one place.
 *
 * Renderer consumers subscribe to the `updater:state` broadcast and call:
 *   - `updater:check`       — request a fresh check
 *   - `updater:install`     — quit + install a downloaded update
 *   - `updater:get-state`   — snapshot the current state (invoke)
 *
 * Back-compat: the legacy `update-state` / `update-apply` IPC channels in
 * index.ts continue to work so existing UpdateStatus.vue keeps functioning.
 */

import { EventEmitter } from 'events';

import { app, ipcMain } from 'electron';

import type { UpdateState as RawUpdateState } from './index';

import Logging from '@pkg/utils/logging';
import * as window from '@pkg/window';

const console = Logging.update;

export type UpdatePhase =
  | 'idle'
  | 'disabled'
  | 'checking'
  | 'not-available'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error';

export type UpdateTrigger = 'manual' | 'auto' | 'startup';

export interface RichUpdateState {
  phase:              UpdatePhase;
  currentVersion:     string;
  availableVersion?:  string;
  releaseNotes?:      string;
  releaseDate?:       string;
  progress?: {
    percent:         number;
    bytesPerSecond:  number;
    transferred:     number;
    total:           number;
  };
  error?:         string;
  trigger?:       UpdateTrigger;
  lastCheckedAt?: number;
  configured:     boolean;
  updaterEnabled: boolean;
  /**
   * Whether this is a packaged production build. Determines whether the
   * Install & Restart button should be wired up — unpacked dev builds can
   * check for updates but cannot actually install.
   */
  isPackaged:     boolean;
  /** Whether the latest server version is newer than our current one. */
  updateAvailable: boolean;
}

/**
 * Shared event bus between index.ts (the low-level driver) and UpdateManager.
 * index.ts emits `raw-state` whenever its broadcast state mutates, and
 * `checking` when a check starts. UpdateManager subscribes to translate raw
 * state into the rich phase model.
 */
export const updateEvents = new EventEmitter();

class UpdateManager extends EventEmitter {
  private state: RichUpdateState = {
    phase:           'idle',
    currentVersion:  app.getVersion(),
    configured:      false,
    updaterEnabled:  false,
    isPackaged:      app.isPackaged,
    updateAvailable: false,
  };

  /** The currently-requested trigger, carried through until the next terminal phase. */
  private pendingTrigger: UpdateTrigger | undefined;

  constructor() {
    super();

    // Subscribe to low-level events immediately — the background.ts startup
    // path calls setupUpdate() directly, so we must be listening before any
    // module-level import finishes to avoid missing the first broadcast.
    updateEvents.on('checking', () => {
      // If a check fires without us knowing about it (timer-driven recheck),
      // tag it as an auto/background check so any resulting download surfaces
      // the Updates window.
      if (!this.pendingTrigger) {
        this.pendingTrigger = 'auto';
      }
      // Don't regress past phases the lightweight check already advanced us
      // into — electron-updater fires its own 'checking-for-update' after we
      // already know the answer, and a visible flash back to 'checking' is
      // poor UX. Only enter 'checking' from terminal or idle states.
      const canEnterChecking = !this.state.phase
        || this.state.phase === 'idle'
        || this.state.phase === 'not-available'
        || this.state.phase === 'error'
        || this.state.phase === 'disabled';

      if (canEnterChecking) {
        this.setState({
          phase:    'checking',
          trigger:  this.pendingTrigger,
          error:    undefined,
          progress: undefined,
        });
      } else {
        // Just update the trigger and clear transient fields.
        this.setState({
          trigger:  this.pendingTrigger,
          error:    undefined,
        });
      }
    });

    updateEvents.on('raw-state', (raw: RawUpdateState) => {
      this.translateRawState(raw);
    });

    // Register IPC handlers eagerly so any early window open can query state
    // without racing against initialize(). Safe to register here since the
    // renderer-facing surface is self-contained.
    this.registerIpc();
  }

  private ipcRegistered = false;

  private registerIpc(): void {
    if (this.ipcRegistered) {
      return;
    }
    this.ipcRegistered = true;

    ipcMain.handle('updater:get-state', () => this.getState());

    ipcMain.handle('updater:check', async(_event, trigger: UpdateTrigger = 'manual') => {
      await this.checkForUpdates(trigger);
    });

    ipcMain.handle('updater:install', () => {
      this.installUpdate();
    });

    ipcMain.on('updater:check', (_event, trigger: UpdateTrigger = 'manual') => {
      this.checkForUpdates(trigger).catch((err) => {
        console.error('[UpdateManager] background check failed:', err);
      });
    });

    ipcMain.on('updater:install', () => {
      this.installUpdate();
    });
  }

  getState(): RichUpdateState {
    return { ...this.state };
  }

  private broadcast() {
    window.send('updater:state' as any, this.state);
    this.emit('state', this.state);
  }

  private setState(patch: Partial<RichUpdateState>) {
    this.state = { ...this.state, ...patch };
    this.broadcast();
  }

  /**
   * Record the user's auto-updater setting and broadcast current state.
   * IPC handlers are already registered by the constructor, so this is safe
   * to call multiple times (e.g. on settings change).
   */
  initialize(updaterEnabled: boolean): void {
    this.state.updaterEnabled = !!updaterEnabled;
    this.broadcast();
    console.log('[UpdateManager] initialized; updaterEnabled=', updaterEnabled);
  }

  /**
   * Entry point for every "check for updates" caller.
   *
   * Two-stage flow:
   *   1. Always run the lightweight responder check — works in dev + prod.
   *      This tells us what the latest version is and whether we're behind.
   *   2. Only in a packaged build, hand off to electron-updater to actually
   *      download & queue the install. Dev builds stop at step 1.
   *
   * Manual triggers always surface the Updates window. Startup / auto checks
   * run silently and only surface the window when a download completes.
   */
  async checkForUpdates(trigger: UpdateTrigger): Promise<void> {
    this.pendingTrigger = trigger;
    this.setState({
      phase:    'checking',
      trigger,
      error:    undefined,
      progress: undefined,
    });

    if (trigger === 'manual') {
      try {
        const { openUpdatesWindow } = await import('@pkg/window');

        openUpdatesWindow();
      } catch (err) {
        console.error('[UpdateManager] failed to open updates window:', err);
      }
    }

    // ── Stage 1: lightweight check (works in dev + prod) ──────────────────
    let lightweightSucceeded = false;

    try {
      const { performLightweightCheck } = await import('./lightweightCheck');
      const result = await performLightweightCheck();

      lightweightSucceeded = true;
      this.setState({
        updateAvailable:  result.updateAvailable,
        availableVersion: result.latestVersion,
        releaseDate:      result.releaseDate,
        releaseNotes:     result.releaseNotes,
        lastCheckedAt:    Date.now(),
        configured:       true,
      });

      if (!result.updateAvailable) {
        this.setState({ phase: 'not-available' });
        this.pendingTrigger = undefined;

        return;
      }

      // Update is available. In dev mode we stop here — no download possible.
      if (!this.state.isPackaged) {
        this.setState({ phase: 'available' });
        this.pendingTrigger = undefined;

        return;
      }
      // Packaged build — leave phase at 'checking' so the UI doesn't flicker
      // through "available" before electron-updater transitions us to
      // 'downloading'. Version/release-notes are already broadcast above so
      // the UI has data to render on the next phase change.
    } catch (err: any) {
      console.error('[UpdateManager] lightweight check failed:', err);
      // Don't hard-fail yet — packaged builds may still succeed via electron-updater.
      if (!this.state.isPackaged) {
        this.setState({
          phase: 'error',
          error: err?.message ?? String(err),
        });
        this.pendingTrigger = undefined;

        return;
      }
    }

    // ── Stage 2: electron-updater (packaged builds only) ──────────────────
    if (!this.state.isPackaged) {
      return;
    }

    try {
      const { default: setupUpdate } = await import('./index');

      await setupUpdate(true, false);
      if (!lightweightSucceeded) {
        this.setState({ lastCheckedAt: Date.now() });
      }
    } catch (err: any) {
      console.error('[UpdateManager] electron-updater stage failed:', err);
      this.setState({
        phase: 'error',
        error: err?.message ?? String(err),
      });
    }
  }

  /**
   * Quit and install a downloaded update.
   * No-op in unpacked development builds — you can't install a DMG into a
   * running `yarn dev` process.
   */
  async installUpdate(): Promise<void> {
    if (!app.isPackaged) {
      console.warn('[UpdateManager] installUpdate ignored — app is not packaged');
      this.setState({
        error: 'Install is only available in packaged builds. Download the latest DMG/installer from GitHub releases.',
      });

      return;
    }
    if (this.state.phase !== 'downloaded') {
      console.warn(`[UpdateManager] installUpdate called while phase=${ this.state.phase }`);

      return;
    }
    const { installQueuedUpdate } = await import('./index');

    installQueuedUpdate();
  }

  /**
   * Translate a raw state broadcast from index.ts into the rich phase model.
   */
  private translateRawState(raw: RawUpdateState): void {
    const patch: Partial<RichUpdateState> = {
      configured: !!raw.configured,
    };

    if (raw.info) {
      patch.availableVersion = raw.info.version;
      patch.releaseNotes     = typeof raw.info.releaseNotes === 'string' ? raw.info.releaseNotes : undefined;
      patch.releaseDate      = raw.info.releaseDate;
    }

    if (raw.progress) {
      patch.progress = {
        percent:        raw.progress.percent,
        bytesPerSecond: raw.progress.bytesPerSecond,
        transferred:    raw.progress.transferred,
        total:          raw.progress.total,
      };
    }

    if (raw.error) {
      patch.phase = 'error';
      patch.error = raw.error.message ?? String(raw.error);
      this.setState(patch);

      return;
    }

    if (!raw.configured) {
      patch.phase = 'disabled';
      this.setState(patch);

      return;
    }

    if (raw.downloaded) {
      const wasBackground = this.pendingTrigger && this.pendingTrigger !== 'manual';

      patch.phase    = 'downloaded';
      patch.progress = undefined;
      this.setState(patch);

      if (wasBackground) {
        // Surface the window so the user sees the install button.
        import('@pkg/window').then(({ openUpdatesWindow }) => {
          try {
            openUpdatesWindow();
          } catch (err) {
            console.error('[UpdateManager] failed to open updates window on download:', err);
          }
        }).catch(() => { /* ignore */ });
      }
      this.pendingTrigger = undefined;

      return;
    }

    if (raw.available) {
      // available + progress → downloading; available alone → available
      patch.phase = raw.progress ? 'downloading' : 'available';
      this.setState(patch);

      return;
    }

    // Update not available. Only mark "not-available" when we actually have
    // server info — otherwise stay in whatever phase we were in.
    if (raw.info && !raw.available && !raw.downloaded) {
      patch.phase = 'not-available';
      this.setState(patch);

      return;
    }

    // Fallback: propagate partial patch without changing phase.
    if (Object.keys(patch).length > 0) {
      this.setState(patch);
    }
  }

  /**
   * Update the cached updater-enabled flag when the user toggles the setting.
   */
  setUpdaterEnabled(enabled: boolean): void {
    if (this.state.updaterEnabled === enabled) {
      return;
    }
    this.setState({ updaterEnabled: enabled });
  }
}

export const updateManager = new UpdateManager();
export default updateManager;
