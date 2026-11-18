// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import { ThreatProtectionLogic } from './threatProtectionLogic';

export interface ThreatSettings {
  enabled: boolean; allowlist: string; blockMode: 'block' | 'warn' | 'off'; injectionMode: 'warn' | 'redact' | 'off';
  scanMaxBytes: number; bufferBudgetMb: number; scanBufferMaxBytes: number; memoryPressurePercent: number;
  trafficLogEnabled: boolean; trafficLogRetentionMinutes: number;
}
export interface ThreatStatus { state: 'running' | 'failing-open' | 'off' | 'starting' | 'standby' | (string & {}); reason?: string; since?: string }
interface Renderer { invoke<T>(channel: string, ...args: unknown[]): Promise<T>; on(channel: string, cb: (_event: unknown, value: ThreatStatus) => void): void; removeListener(channel: string, cb: (_event: unknown, value: ThreatStatus) => void): void }
const renderer = ipcRenderer as unknown as Renderer;
const logic = new ThreatProtectionLogic();
export const validThreatHost = (value: string): boolean => logic.isValidHost(value);
export function useThreatProtection() {
  const settings = ref<ThreatSettings>({ enabled: true, allowlist: '', blockMode: 'block', injectionMode: 'warn', scanMaxBytes: 2097152, bufferBudgetMb: 48, scanBufferMaxBytes: 4194304, memoryPressurePercent: 60, trafficLogEnabled: false, trafficLogRetentionMinutes: 30 });
  const keyStatus = ref({ safeBrowsing: false, virusTotal: false }); const status = ref<ThreatStatus>({ state: 'starting' });
  const entries = ref<Record<string, any>[]>([]); const search = ref(''); const verdict = ref(''); const error = ref('');
  let timer: ReturnType<typeof setInterval> | undefined; let visible = false;
  const statusListener = (_event: unknown, value: ThreatStatus) => { status.value = value; };
  async function load() { const result = await renderer.invoke<{ok:boolean;settings?:ThreatSettings;keyStatus?:typeof keyStatus.value;error?:string}>('threat-proxy:get-settings'); if (result.ok && result.settings) settings.value = result.settings; if (result.keyStatus) keyStatus.value = result.keyStatus; else error.value = result.error ?? ''; await refreshStatus(); }
  async function refreshStatus() { status.value = await renderer.invoke<ThreatStatus>('threat-proxy:get-status'); }
  async function save(patch: Partial<ThreatSettings>) { const result = await renderer.invoke<{ok:boolean;settings?:ThreatSettings;error?:string}>('threat-proxy:set-settings', patch); if (result.ok && result.settings) settings.value = result.settings; else error.value = result.error ?? 'Could not save settings'; }
  async function refreshLog() { if (!visible || !settings.value.trafficLogEnabled) return; const result = await renderer.invoke<{entries:Record<string,any>[];error?:string}>('threat-proxy:get-traffic-log', logic.logRequest(search.value, verdict.value)); entries.value = result.entries; }
  function setVisible(value: boolean) { visible = value; if (timer) clearInterval(timer); timer = undefined; if (visible && settings.value.trafficLogEnabled) { void refreshLog(); timer = setInterval(() => void refreshLog(), 5000); } }
  async function setLog(patch: Partial<ThreatSettings>) { await save(patch); setVisible(visible); }
  async function clearLog() { await renderer.invoke('threat-proxy:clear-traffic-log'); entries.value = []; }
  onMounted(() => { renderer.on('threat-proxy:status-changed', statusListener); void load(); });
  onBeforeUnmount(() => { renderer.removeListener('threat-proxy:status-changed', statusListener); if (timer) clearInterval(timer); });
  return { settings, keyStatus, status, entries, search, verdict, error, save, setLog, clearLog, refreshLog, setVisible };
}
