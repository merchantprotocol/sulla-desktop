<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import SecurityIcon from './security/SecurityIcon.vue';
import PrefCard from '../PrefCard.vue';
import PrefRow from '../PrefRow.vue';
import PrefToggle from '../PrefToggle.vue';
import SandboxCard from './security/SandboxCard.vue';
import ThreatProtectionCard from './security/ThreatProtectionCard.vue';
import VaultCard from './security/VaultCard.vue';
import FileEncryptionCard from './security/FileEncryptionCard.vue';
import ApprovalsCard from './security/ApprovalsCard.vue';
import ActivityCard from './security/ActivityCard.vue';
import ProtectedAreasCard from './security/ProtectedAreasCard.vue';
import { useSecurity } from '@pkg/composables/preferences/useSecurity';
import { openMainTab } from '@pkg/composables/preferences/openInMain';
import { useEngineSettings } from '@pkg/composables/preferences/useEngineSettings';
import { useThreatProtection } from '@pkg/composables/preferences/useThreatProtection';
import { SecurityReportLogic } from './security/securityReportLogic';
import type { CheckId } from './security/types';
const emit = defineEmits<{ (event: 'go', section: 'threat' | 'files'): void }>();
const security = useSecurity();
const { get, set, isLocked } = useEngineSettings();
const threatProxy = useThreatProtection();
const reportLogic = new SecurityReportLogic();
const copied = ref(false);
const hostAccess = computed(() => get('application.hostAccess') === true);
const summary = computed(() => security.summary.value);
const report = computed(() => security.report.value);
const header = computed(() => reportLogic.header(report.value));
const threatStatus = computed(() => String(threatProxy.status.value.state));
const checks = computed(() => report.value?.checks ?? []);
const expectedChecks = [
  ['runtime', 'Agent runtime'], ['containers', 'Sub-agent containers'], ['threatProxy', 'Threat proxy'], ['blocklist', 'Threat blocklist'],
  ['vault', 'Password vault'], ['filesEncryption', 'File encryption'], ['hostAccess', 'Mac host access'], ['signature', 'App signature'],
] as const;
const progressItems = computed(() => {
  if (!security.checking.value) return report.value?.checks ?? [];
  const completed = new Map(security.progress.value.map(check => [check.id, check]));
  return expectedChecks.map(([id, label]) => completed.get(id) ?? { id, label, status: 'not_checked' as const, detail: '' });
});
function statusName(status: string) { return status === 'pass' ? 'Pass' : status === 'not_checked' ? 'Not checked' : status === 'warn' ? 'Warning' : 'Failed'; }
const checkTargets: Record<CheckId, string> = {
  runtime: 'security-sandbox', containers: 'security-sandbox', hostAccess: 'security-sandbox',
  threatProxy: 'security-threat', blocklist: 'security-threat', vault: 'security-vault',
  filesEncryption: 'security-files', signature: 'security-sandbox',
};
const checkedAt = computed(() => report.value?.finishedAt ? new Date(report.value.finishedAt).toLocaleString() : '');
function scrollTo(id: CheckId) { document.getElementById(checkTargets[id])?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
function openFiles() { openMainTab('files'); }
async function copyReport() {
  if (!report.value) return;
  try {
    await navigator.clipboard.writeText(reportLogic.copyText(report.value));
    copied.value = true;
    window.setTimeout(() => { copied.value = false; }, 1600);
  } catch (error) { security.error.value = error instanceof Error ? error.message : 'Clipboard access failed.'; }
}
</script>
<template>
  <div class="security-section">
    <header><h1>Security</h1><p>Every protection keeping your Mac, your files and your passwords safe from agent mistakes and bad websites.</p></header>
    <section class="security-status" :class="header.tone" aria-live="polite">
      <div class="status-title"><span class="hero-icon"><SecurityIcon :name="header.tone === 'warning' ? 'alert' : 'shield'" :size="22" /></span><div class="hero-copy"><h2>{{ report ? (header.tone === 'success' ? 'Sulla is protected' : header.tone === 'warning' ? 'Sulla needs your attention' : 'Security check complete') : 'Security status' }}</h2>
        <p v-if="report">{{ header.score }} protections on<span v-if="checkedAt"> · Last checked {{ checkedAt }}</span></p><p v-else>Run a security check to see your protection status.</p></div>
        <div class="hero-action"><button type="button" class="run" :disabled="security.checking.value" @click="security.runCheck()"><SecurityIcon name="scan" :size="16" />{{ security.checking.value ? 'Checking…' : report ? 'Run security check again' : 'Run security check' }}</button><small>Takes a few seconds</small></div></div>
      <p v-if="header.reason" class="reason">{{ header.reason }}</p>
      <div v-if="checks.length" class="chips"><button v-for="check in checks" :key="check.id" type="button" :class="check.status" @click="scrollTo(check.id)"><i></i>{{ check.label }}</button></div>
      <div v-if="security.loading.value" class="state" aria-live="polite">Loading security status…</div>
      <div v-if="security.error.value || threatProxy.error.value" role="alert" class="error">Could not load security data: {{ security.error.value || threatProxy.error.value }}</div>
      <div v-if="progressItems.length" class="progress"><ul><li v-for="check in progressItems" :key="check.id" :class="[check.status, security.checking.value && !security.progress.value.some(item => item.id === check.id) ? 'pending' : '']"><span class="step-icon"><span v-if="security.checking.value && !security.progress.value.some(item => item.id === check.id)" class="spinner"></span><SecurityIcon v-else :name="check.status === 'pass' ? 'check' : check.status === 'not_checked' ? 'eye' : 'alert'" :size="15" /></span><span class="step-copy"><b>{{ check.label }}</b><small>{{ security.checking.value && !security.progress.value.some(item => item.id === check.id) ? 'Checking…' : check.detail }}</small></span><span class="step-status">{{ security.checking.value && !security.progress.value.some(item => item.id === check.id) ? 'Checking' : statusName(check.status) }}</span></li></ul>
        <div v-if="report && !security.checking.value" class="report-summary"><span><b>{{ header.tone === 'success' ? 'All checks passed' : 'Check complete' }}</b><small>{{ header.tone === 'success' ? 'Nothing needs your attention.' : header.reason }}</small></span><button type="button" class="copy" @click="copyReport"><SecurityIcon name="copy" :size="15" />{{ copied ? 'Copied' : 'Copy report' }}</button></div>
      </div>
    </section>
    <div class="card-grid">
      <SandboxCard :runtime="checks.find(check => check.id === 'runtime')" :containers="checks.find(check => check.id === 'containers')" :host-access="hostAccess" :locked="isLocked('application.hostAccess')" @update:host-access="set('application.hostAccess', $event)" />
      <ThreatProtectionCard :threat="summary?.threat ?? null" :status="threatStatus" @go="emit('go', 'threat')" />
      <VaultCard id="security-vault" :vault="summary?.vault ?? null" :busy="security.locking.value" @lock="security.lockVault()" />
      <FileEncryptionCard id="security-files" :vault="summary?.vault ?? null" @go="openFiles" />
      <ApprovalsCard :approvals="summary?.approvals ?? null" :rules="summary?.rules ?? null" />
      <ActivityCard :activity="summary?.activity ?? null" @go="openFiles" />
      <ProtectedAreasCard :vault="summary?.vault ?? null" />
    </div>
    <PrefCard title="Usage data"><PrefRow title="Share anonymous usage statistics" subtitle="Never includes your files, chats or passwords."><PrefToggle :model-value="get('application.telemetry.enabled')" :disabled="isLocked('application.telemetry.enabled')" label="Share anonymous usage statistics" @update:model-value="set('application.telemetry.enabled', $event)" /></PrefRow></PrefCard>
  </div>
</template>
<style scoped>
.security-section{display:grid;gap:16px}header h1,header p{margin:0}header p{color:var(--text-muted);margin-top:5px}.security-status{padding:18px;border:1px solid var(--border-muted);border-radius:var(--radius-panel);background:var(--surface-1)}.security-status.success{border-color:var(--border-success)}.security-status.warning{border-color:var(--border-warning)}.status-title{display:flex;align-items:center;gap:13px}.hero-icon{width:44px;height:44px;display:grid;place-items:center;border-radius:12px;background:var(--status-success-soft);color:var(--success);flex:none}.warning .hero-icon{background:var(--status-warning-soft);color:var(--warning)}.hero-copy{flex:1}.hero-copy h2,.hero-copy p{margin:0}.hero-copy h2{font-size:17px}.hero-copy p{color:var(--text-muted);margin-top:4px}.hero-action{display:flex;align-items:flex-end;flex-direction:column;gap:5px}.hero-action small{color:var(--text-muted)}.run,.copy{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--accent);border-radius:var(--radius-ctl);padding:9px 13px;color:var(--text-on-accent);background:var(--accent);cursor:pointer}.copy{color:var(--text);background:var(--surface-1);border-color:var(--border)}button:disabled{opacity:.6;cursor:wait}.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}.chips button{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--border-muted);border-radius:999px;padding:6px 10px;color:var(--text-muted);background:var(--surface-1);font-size:11px;cursor:pointer}.chips i{width:7px;height:7px;border-radius:50%;background:currentColor}.chips .pass{color:var(--success);border-color:var(--border-success);background:var(--status-success-soft)}.chips .warn{color:var(--warning);border-color:var(--border-warning);background:var(--status-warning-soft)}.chips .fail{color:var(--danger);border-color:var(--border-error);background:var(--status-error-soft)}.state{margin-top:12px;color:var(--text-muted)}.error{color:var(--danger);margin-top:12px}.progress{border-top:1px solid var(--border-muted);margin-top:16px;padding-top:8px}.progress ul{list-style:none;margin:0;padding:0}.progress li{display:flex;align-items:center;gap:10px;padding:7px 2px}.step-icon{width:22px;height:22px;display:grid;place-items:center;border-radius:50%;color:var(--success);background:var(--status-success-soft);flex:none}.progress .warn .step-icon{color:var(--warning);background:var(--status-warning-soft)}.progress .fail .step-icon{color:var(--danger);background:var(--status-error-soft)}.pending .step-icon{background:var(--surface-2);color:var(--text-muted)}.step-copy{flex:1}.step-copy b{font-size:12px}.step-copy small,.report-summary small{display:block;color:var(--text-muted);font-size:11px;margin-top:2px}.step-status{color:var(--text-muted);font-size:11px}.report-summary{display:flex;align-items:center;justify-content:space-between;border-top:1px solid var(--border-muted);padding-top:12px;margin-top:7px}.spinner{width:13px;height:13px;border:2px solid var(--border-muted);border-top-color:var(--accent);border-radius:50%;animation:spin .7s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.card-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
@media(max-width:760px){.card-grid{grid-template-columns:1fr}.hero-action{align-items:flex-start}.status-title{flex-wrap:wrap}.hero-action{width:100%;margin-left:57px}}
</style>
