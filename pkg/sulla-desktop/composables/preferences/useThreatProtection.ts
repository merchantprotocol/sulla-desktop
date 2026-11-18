// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import { ThreatProtectionLogic } from './threatProtectionLogic';

export interface ThreatSettings {
  enabled:                    boolean;
  allowlist:                  string;
  blockMode:                  'block' | 'warn' | 'off';
  injectionMode:              'warn' | 'redact' | 'off';
  scanMaxBytes:               number;
  bufferBudgetMb:             number;
  scanBufferMaxBytes:         number;
  memoryPressurePercent:      number;
  trafficLogEnabled:          boolean;
  trafficLogRetentionMinutes: number;
}

export interface ThreatStatus {
  state:                   'running' | 'failing-open' | 'off' | 'starting' | 'standby' | (string & {});
  reason?:                 string;
  since?:                  string;
  failOpenTransitions24h?: number;
}

export type TrafficLogEntry = Record<string, any>;

const logic = new ThreatProtectionLogic();
const LOG_REFRESH_MS = 5000;

export const validThreatHost = (value: string): boolean => logic.isValidHost(value);

export function useThreatProtection() {
  const settings = ref<ThreatSettings>({
    enabled:                    true,
    allowlist:                  '',
    blockMode:                  'block',
    injectionMode:              'warn',
    scanMaxBytes:               2097152,
    bufferBudgetMb:             48,
    scanBufferMaxBytes:         4194304,
    memoryPressurePercent:      60,
    trafficLogEnabled:          false,
    trafficLogRetentionMinutes: 30,
  });
  const keyStatus = ref({ safeBrowsing: false, virusTotal: false });
  const status = ref<ThreatStatus>({ state: 'starting' });
  const entries = ref<TrafficLogEntry[]>([]);
  const summaryEntries = ref<TrafficLogEntry[]>([]);
  const search = ref('');
  const verdict = ref('');
  const error = ref('');
  let timer: ReturnType<typeof setInterval> | undefined;
  let visible = false;

  const statusListener = (_event: Electron.IpcRendererEvent, value: ThreatStatus) => {
    status.value = value;
  };

  async function refreshStatus() {
    status.value = await ipcRenderer.invoke('threat-proxy:get-status');
  }

  async function load() {
    const result = await ipcRenderer.invoke('threat-proxy:get-settings');

    if (result.ok && result.settings) settings.value = result.settings;
    if (result.keyStatus) keyStatus.value = result.keyStatus;
    error.value = result.ok ? '' : result.error ?? '';
    await refreshStatus();
  }

  async function save(patch: Partial<ThreatSettings>) {
    const result = await ipcRenderer.invoke('threat-proxy:set-settings', patch);

    if (result.ok && result.settings) {
      settings.value = result.settings;
    } else {
      error.value = result.error ?? 'Could not save settings';
    }
  }

  async function refreshLog() {
    if (!visible || !settings.value.trafficLogEnabled) return;
    const [result, summary] = await Promise.all([
      ipcRenderer.invoke('threat-proxy:get-traffic-log', logic.logRequest(search.value, verdict.value)),
      ipcRenderer.invoke('threat-proxy:get-traffic-log', logic.logRequest('', '')),
    ]);

    entries.value = result.entries;
    summaryEntries.value = summary.entries;
  }

  function setVisible(value: boolean) {
    visible = value;
    if (timer) clearInterval(timer);
    timer = undefined;
    if (visible && settings.value.trafficLogEnabled) {
      void refreshLog();
      timer = setInterval(() => void refreshLog(), LOG_REFRESH_MS);
    }
  }

  async function setLog(patch: Partial<ThreatSettings>) {
    await save(patch);
    setVisible(visible);
  }

  async function clearLog() {
    await ipcRenderer.invoke('threat-proxy:clear-traffic-log');
    entries.value = [];
    summaryEntries.value = [];
  }

  onMounted(() => {
    ipcRenderer.on('threat-proxy:status-changed', statusListener);
    void load();
  });
  onBeforeUnmount(() => {
    ipcRenderer.removeListener('threat-proxy:status-changed', statusListener);
    if (timer) clearInterval(timer);
  });

  return {
    settings,
    keyStatus,
    status,
    entries,
    summaryEntries,
    search,
    verdict,
    error,
    save,
    setLog,
    clearLog,
    refreshLog,
    setVisible,
  };
}
