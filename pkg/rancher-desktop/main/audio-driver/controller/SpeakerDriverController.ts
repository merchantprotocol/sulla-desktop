/**
 * @module audio-driver/controller/SpeakerDriverController
 *
 * # SpeakerDriverController — Main-Process Owner of Speaker Capture State
 *
 * Owns the speaker capture lifecycle: BlackHole loopback driver detection/
 * install, CoreAudio aggregate mirror device creation, Swift capture helper,
 * volume key interception, and device-change watching.
 *
 * Also notifies the tray panel renderer when the speaker pipeline starts/stops
 * so it can initialize/tear down speakerVad, feedback detection, and other
 * speaker-side processing.
 *
 * ## Reference-counted lifecycle
 *
 * Multiple services can hold the speaker open simultaneously.
 * `start(serviceId)` / `stop(serviceId)` add/remove the service from a Set.
 * Hardware only activates when the set goes 0 → 1, deactivates when 1 → 0.
 *
 * Service IDs: `'audio-settings-test'`, `'secretary-mode'`,
 * `'call-session'`, etc.
 */

import { type WebContents } from 'electron';

import * as lifecycle from './lifecycle';
import * as audio from '../model/audio';
import { log } from '../model/logger';

// ── Singleton ───────────────────────────────────────────────────

let instance: SpeakerDriverController | null = null;

export class SpeakerDriverController {
  private static readonly TAG = 'SpeakerDriverController';

  // ── State ─────────────────────────────────────────────────────

  private _running = false;
  private _speakerName = '';

  // ── Reference set ─────────────────────────────────────────────

  /** Maps serviceId → the WebContents that requested it (for targeted sends). */
  private _holders = new Map<string, WebContents>();

  /** Cleanup listeners keyed by serviceId — removes holder when its WebContents is destroyed. */
  private _destroyListeners = new Map<string, () => void>();

  // ── Level/rebuild callbacks (set by init.ts for broadcasting) ─

  private _onLevel:   ((data: any) => void) | null = null;
  private _onRebuild: ((event: any) => void) | null = null;

  // ── Constructor ───────────────────────────────────────────────

  private constructor() {
    log.info(SpeakerDriverController.TAG, 'Initializing singleton');
  }

  static getInstance(): SpeakerDriverController {
    if (!instance) {
      instance = new SpeakerDriverController();
    }
    return instance;
  }

  // ── Callbacks (set by init.ts) ────────────────────────────────

  /**
   * Set callbacks for speaker level data and device rebuild events.
   * init.ts uses these to broadcast speaker data to all renderers.
   */
  setCallbacks(opts: {
    onLevel:   (data: any) => void;
    onRebuild: (event: any) => void;
  }): void {
    this._onLevel = opts.onLevel;
    this._onRebuild = opts.onRebuild;
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  /**
   * Request speaker capture for a service. If first holder:
   * Activates BlackHole mirror + CoreAudio pipeline (main process).
   * Speaker level data is sent only to holder windows.
   *
   * @param serviceId - Identifies who is requesting the speaker
   * @param sender - The WebContents of the requesting window (for targeted sends)
   */
  async start(serviceId: string, sender?: WebContents): Promise<void> {
    log.info(SpeakerDriverController.TAG, 'start()', { serviceId, currentHolders: [...this._holders.keys()], running: this._running });

    // Remove any previous destroy listener for this serviceId (re-registration)
    this._removeDestroyListener(serviceId);

    if (sender && !sender.isDestroyed()) {
      this._holders.set(serviceId, sender);

      // Auto-remove holder when its renderer is destroyed (window closed, navigated away, crashed)
      const onDestroyed = () => {
        log.info(SpeakerDriverController.TAG, 'WebContents destroyed — auto-releasing holder', { serviceId });
        this.stop(serviceId).catch((e: any) => {
          log.error(SpeakerDriverController.TAG, 'Auto-release stop() failed', { serviceId, error: e.message });
        });
      };
      sender.once('destroyed', onDestroyed);
      this._destroyListeners.set(serviceId, onDestroyed);

      log.info(SpeakerDriverController.TAG, 'Holder registered with WebContents + destroy listener', { serviceId });
    } else {
      this._holders.set(serviceId, null as any);
      log.warn(SpeakerDriverController.TAG, 'Holder registered WITHOUT WebContents (no auto-cleanup)', { serviceId });
    }

    if (!this._running) {
      log.info(SpeakerDriverController.TAG, 'First holder — activating lifecycle (BlackHole + CoreAudio)');
      try {
        await lifecycle.activate({
          onLevel:   this._onLevel || (() => {}),
          onRebuild: this._onRebuild || (() => {}),
        });
        this._running = true;
        this._persist();
        log.info(SpeakerDriverController.TAG, 'Speaker pipeline started', { holders: [...this._holders.keys()] });
      } catch (e: any) {
        log.error(SpeakerDriverController.TAG, 'lifecycle.activate() failed', { error: e.message });
        throw e;
      }
    } else {
      log.info(SpeakerDriverController.TAG, 'Speaker already running — added holder only', { serviceId, totalHolders: this._holders.size });
    }
  }

  /**
   * Release speaker capture for a service. If no holders remain,
   * deactivates BlackHole mirror + CoreAudio pipeline.
   */
  async stop(serviceId: string): Promise<void> {
    log.info(SpeakerDriverController.TAG, 'stop()', { serviceId, currentHolders: [...this._holders.keys()], running: this._running });

    const wasHolder = this._holders.has(serviceId);
    this._holders.delete(serviceId);
    this._removeDestroyListener(serviceId);
    log.info(SpeakerDriverController.TAG, 'Holder removed', { serviceId, wasHolder, remainingHolders: [...this._holders.keys()] });

    if (this._running && this._holders.size === 0) {
      log.info(SpeakerDriverController.TAG, 'Last holder released — deactivating lifecycle');
      await lifecycle.deactivate({ removeDriver: false });

      this._running = false;
      this._persist();
      log.info(SpeakerDriverController.TAG, 'Speaker pipeline stopped');
    } else if (this._holders.size > 0) {
      log.info(SpeakerDriverController.TAG, 'Speaker still held by other services', { remaining: [...this._holders.keys()] });
    } else if (!this._running) {
      log.warn(SpeakerDriverController.TAG, 'stop() called but speaker was not running', { serviceId });
    }
  }

  // ── State ─────────────────────────────────────────────────────

  get running(): boolean { return this._running }
  get speakerName(): string { return this._speakerName }
  get holders(): string[] { return [...this._holders.keys()] }

  isHolder(serviceId: string): boolean {
    return this._holders.has(serviceId);
  }

  // ── Volume control (delegates to lifecycle) ───────────────────

  async volumeUp() { return lifecycle.speakerVolumeUp() }
  async volumeDown() { return lifecycle.speakerVolumeDown() }
  async muteToggle() { return lifecycle.speakerMuteToggle() }
  async volumeGet() { return lifecycle.speakerVolumeGet() }

  setOnVolumeChanged(cb: (state: any) => void): void {
    lifecycle.setOnVolumeChanged(cb);
  }

  // ── Shutdown ──────────────────────────────────────────────────

  async shutdown(): Promise<void> {
    log.info(SpeakerDriverController.TAG, 'Shutting down');
    if (this._running) {
      await lifecycle.deactivate({ removeDriver: false });
    }
    this._running = false;
    for (const sid of this._destroyListeners.keys()) {
      this._removeDestroyListener(sid);
    }
    this._holders.clear();
    instance = null;
  }

  /** Send only to windows that are holding the speaker open. */
  sendToHolders(channel: string, data: any): void {
    for (const [, sender] of this._holders) {
      if (sender && !sender.isDestroyed()) {
        sender.send(channel, data);
      }
    }
  }

  // ── Private ───────────────────────────────────────────────────

  private _persist(): void {
    audio.savePrefs({ ...audio.loadPrefs(), speakerEnabled: this._running });
  }

  /** Remove the WebContents 'destroyed' listener for a serviceId, if one exists. */
  private _removeDestroyListener(serviceId: string): void {
    const listener = this._destroyListeners.get(serviceId);
    if (listener) {
      const sender = this._holders.get(serviceId);
      if (sender && !sender.isDestroyed()) {
        sender.removeListener('destroyed', listener);
      }
      this._destroyListeners.delete(serviceId);
    }
  }
}
