// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export type StorageLevel = 'warning' | 'critical';

export interface StorageProbeResult { freeBytes: number; totalBytes: number; vmUsedPct: number | 'unknown' }
export interface StorageWatchSettings {
  enabled: boolean; warningFreeGb: number; warningFreePct: number;
  criticalFreeGb: number; criticalFreePct: number;
  lastWarningAt: number; lastCriticalAt: number;
}
export interface StorageWatchSettingsStore {
  read(): StorageWatchSettings;
  writeLastRun(level: StorageLevel, timestamp: number): void;
}
export interface StorageWorkflowRunner {
  isRunInProgress(): Promise<boolean>;
  start(inputs: Record<string, string | number>): Promise<'started' | 'unavailable'>;
}
export interface StorageNotifier { show(message: string): void }
export interface StorageWatchLogger { info(message: string): void; warn(message: string, error?: unknown): void }
export interface StorageWatchClock { now(): number }

const GIB = 2 ** 30;
const COOLDOWN_MS = 12 * 60 * 60 * 1_000;
const FIRST_CHECK_MS = 5 * 60 * 1_000;
const CHECK_INTERVAL_MS = 15 * 60 * 1_000;

/** Probes host storage and admits optimizer runs without involving a model. */
export class StorageWatchService {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private checking = false;
  private workflowWarningShown = false;

  constructor(
    private readonly probe: () => Promise<StorageProbeResult>,
    private readonly settings: StorageWatchSettingsStore,
    private readonly workflow: StorageWorkflowRunner,
    private readonly notifier: StorageNotifier,
    private readonly clock: StorageWatchClock,
    private readonly logger: StorageWatchLogger,
  ) {}

  start(): void {
    if (this.timer) return;
    this.schedule(FIRST_CHECK_MS);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  async check(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const config = this.settings.read();
      if (!config.enabled) return;
      const storage = await this.probe();
      const level = this.levelFor(storage, config);
      if (!level || !this.cooldownAllows(level, config, this.clock.now())) return;
      if (await this.workflow.isRunInProgress()) return;

      const freeGb = Number((storage.freeBytes / GIB).toFixed(1));
      const freePct = Number(((storage.freeBytes / storage.totalBytes) * 100).toFixed(1));
      const result = await this.workflow.start({
        level, mac_free_gb: freeGb, mac_free_pct: freePct, vm_used_pct: storage.vmUsedPct,
      });
      const now = this.clock.now();
      this.settings.writeLastRun(level, now);
      if (result === 'unavailable') {
        if (!this.workflowWarningShown) {
          this.workflowWarningShown = true;
          this.logger.warn("[StorageWatch] Storage Optimizer workflow isn't installed or published yet");
        }
        this.notifier.show(`Disk space low: ${ freeGb.toFixed(1) } GB free. Storage Optimizer workflow isn't installed yet.`);
        return;
      }
      this.logger.info(`[StorageWatch] Started Storage Optimizer at ${ level } level (${ freeGb.toFixed(1) } GB free)`);
      this.notifier.show(`Disk space low: ${ freeGb.toFixed(1) } GB free. Storage Optimizer is cleaning up safely.`);
    } catch (error) {
      this.logger.warn('[StorageWatch] Storage check failed; startup and other services are unaffected', error);
    } finally {
      this.checking = false;
    }
  }

  levelFor(storage: StorageProbeResult, config: StorageWatchSettings): StorageLevel | undefined {
    if (!Number.isFinite(storage.freeBytes) || !Number.isFinite(storage.totalBytes) || storage.totalBytes <= 0) return undefined;
    const freeGb = storage.freeBytes / GIB;
    const freePct = (storage.freeBytes / storage.totalBytes) * 100;
    if (freeGb < config.criticalFreeGb || freePct < config.criticalFreePct) return 'critical';
    if (freeGb < config.warningFreeGb || freePct < config.warningFreePct) return 'warning';
  }

  cooldownAllows(level: StorageLevel, config: StorageWatchSettings, now: number): boolean {
    const sameLevelAt = level === 'critical' ? config.lastCriticalAt : config.lastWarningAt;
    if (sameLevelAt > 0 && now - sameLevelAt < COOLDOWN_MS) return false;
    if (level === 'critical') return true;
    return !(config.lastCriticalAt > 0 && now - config.lastCriticalAt < COOLDOWN_MS);
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      void this.check().finally(() => this.schedule(CHECK_INTERVAL_MS));
    }, delay);
    this.timer.unref?.();
  }
}
