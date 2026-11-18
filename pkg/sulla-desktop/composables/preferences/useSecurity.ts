// SPDX-License-Identifier: GPL-2.0-or-later
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import type { SecurityCheckReport, SecurityCheckResult, SecuritySummary } from '@pkg/components/settings/sections/security/types';

interface SecurityIpc {
  invoke(channel: 'security:run-check'): Promise<SecurityCheckReport>;
  invoke(channel: 'security:summary'): Promise<SecuritySummary>;
  invoke(channel: 'security:lock-vault'): Promise<{ ok: boolean; error?: string }>;
  on(channel: 'security:check-progress', listener: (event: Electron.IpcRendererEvent, result: SecurityCheckResult) => void): unknown;
  removeListener(channel: 'security:check-progress', listener: (event: Electron.IpcRendererEvent, result: SecurityCheckResult) => void): unknown;
}

export class SecurityController {
  readonly summary = ref<SecuritySummary | null>(null);
  readonly report = ref<SecurityCheckReport | null>(null);
  readonly progress = ref<SecurityCheckResult[]>([]);
  readonly loading = ref(true);
  readonly checking = ref(false);
  readonly locking = ref(false);
  readonly error = ref('');
  private readonly ipc = ipcRenderer as unknown as SecurityIpc;
  private readonly onProgress = (_event: Electron.IpcRendererEvent, result: SecurityCheckResult) => this.progress.value.push(result);

  mount() {
    this.ipc.on('security:check-progress', this.onProgress);
    void this.loadSummary();
  }

  unmount() { this.ipc.removeListener('security:check-progress', this.onProgress); }

  async loadSummary() {
    this.loading.value = true;
    this.error.value = '';
    try {
      this.summary.value = await this.ipc.invoke('security:summary');
      this.report.value = this.summary.value.lastReport;
    } catch (error) {
      this.error.value = error instanceof Error ? error.message : String(error);
    } finally { this.loading.value = false; }
  }

  async runCheck() {
    this.checking.value = true; this.error.value = ''; this.progress.value = [];
    try {
      this.report.value = await this.ipc.invoke('security:run-check');
      if (this.summary.value) this.summary.value = { ...this.summary.value, lastReport: this.report.value };
    } catch (error) {
      this.error.value = error instanceof Error ? error.message : String(error);
    } finally { this.checking.value = false; }
  }

  async lockVault() {
    this.locking.value = true; this.error.value = '';
    try {
      const result = await this.ipc.invoke('security:lock-vault');
      if (!result.ok) throw new Error(result.error ?? 'Could not lock the password vault.');
      if (this.summary.value?.vault) this.summary.value = { ...this.summary.value, vault: { ...this.summary.value.vault, locked: true } };
    } catch (error) { this.error.value = error instanceof Error ? error.message : String(error); }
    finally { this.locking.value = false; }
  }
}

export function useSecurity() {
  const controller = new SecurityController();
  onMounted(() => controller.mount());
  onBeforeUnmount(() => controller.unmount());
  return controller;
}
