<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<script setup lang="ts">
import { computed, ref } from 'vue';
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
    <section class="security-status" :class="header.tone">
      <div class="status-title"><span aria-hidden="true">{{ header.tone === 'success' ? '✓' : header.tone === 'warning' ? '!' : '…' }}</span><div><h2>{{ header.tone === 'neutral' ? 'Security status unavailable' : header.tone === 'warning' ? 'Sulla needs your attention' : 'Sulla is protected' }}</h2>
        <p v-if="header.score">{{ header.score }} protections on<span v-if="checkedAt"> · Last checked {{ checkedAt }}</span></p><p v-else>Run a security check to see your protection status.</p></div></div>
      <p v-if="header.reason" class="reason">{{ header.reason }}</p>
      <div v-if="checks.length" class="chips"><button v-for="check in checks" :key="check.id" type="button" @click="scrollTo(check.id)">{{ check.label }}</button></div>
      <div class="actions"><button type="button" class="run" :disabled="security.checking.value" @click="security.runCheck()">{{ security.checking.value ? 'Checking…' : report ? 'Run security check again' : 'Run security check' }}</button><span v-if="security.checking.value">Takes a few seconds</span><button v-if="report" type="button" class="copy" @click="copyReport">{{ copied ? 'Copied' : 'Copy report' }}</button></div>
      <div v-if="security.loading.value" class="state" aria-live="polite">Loading security status…</div>
      <div v-if="security.error.value || threatProxy.error.value" role="alert" class="error">Could not load security data: {{ security.error.value || threatProxy.error.value }}</div>
      <TransitionGroup v-if="security.checking.value && security.progress.value.length" name="check" tag="div" class="progress" aria-live="polite"><div v-for="check in security.progress.value" :key="check.id"><span>{{ check.status === 'pass' ? '✓' : check.status === 'not_checked' ? '—' : '!' }}</span> {{ check.label }} — {{ check.detail }}</div></TransitionGroup>
      <TransitionGroup v-else-if="report" name="check" tag="div" class="progress" aria-live="polite"><div v-for="check in report.checks" :key="check.id"><span>{{ check.status === 'pass' ? '✓' : check.status === 'not_checked' ? '—' : '!' }}</span> {{ check.label }} — {{ check.detail }}</div></TransitionGroup>
    </section>
    <SandboxCard :runtime="checks.find(check => check.id === 'runtime')" :containers="checks.find(check => check.id === 'containers')" :host-access="hostAccess" :locked="isLocked('application.hostAccess')" @update:host-access="set('application.hostAccess', $event)" />
    <ThreatProtectionCard :threat="summary?.threat ?? null" :status="threatStatus" @go="emit('go', 'threat')" />
    <VaultCard id="security-vault" :vault="summary?.vault ?? null" :busy="security.locking.value" @lock="security.lockVault()" />
    <FileEncryptionCard id="security-files" :vault="summary?.vault ?? null" @go="openFiles" />
    <ApprovalsCard :approvals="summary?.approvals ?? null" :rules="summary?.rules ?? null" />
    <ActivityCard :activity="summary?.activity ?? null" @go="openFiles" />
    <ProtectedAreasCard :vault="summary?.vault ?? null" />
    <PrefCard title="Usage data"><PrefRow title="Share anonymous usage statistics" subtitle="Never includes your files, chats or passwords."><PrefToggle :model-value="get('application.telemetry.enabled')" :disabled="isLocked('application.telemetry.enabled')" label="Share anonymous usage statistics" @update:model-value="set('application.telemetry.enabled', $event)" /></PrefRow></PrefCard>
  </div>
</template>
<style scoped>
.security-section { display:grid; gap:16px; }
header h1, header p { margin:0; } header p { color:var(--text-muted); margin-top:5px; }
.security-status { padding:18px; border:1px solid var(--border); border-radius:var(--radius-ctl); background:var(--surface-1); }
.security-status.success { border-color:var(--border-success); background:var(--bg-success); }
.security-status.warning { border-color:var(--border-warning); background:var(--bg-warning); }
.status-title { display:flex; align-items:center; gap:12px; } .status-title h2,.status-title p { margin:0; } .status-title p { color:var(--text-muted); margin-top:3px; }
.status-title > span { font-size:24px; color:var(--success); } .warning .status-title > span,.reason { color:var(--warning); }
.chips,.actions { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-top:14px; }
.chips button,.copy,.run { border:1px solid var(--border); border-radius:var(--radius-ctl); padding:8px 12px; color:var(--text); background:var(--surface-1); cursor:pointer; }
.run { color:var(--text-on-accent); background:var(--accent); border-color:var(--accent); } button:disabled { opacity:.6; cursor:wait; }
.actions span,.state { color:var(--text-muted); } .progress { border-top:1px solid var(--border); margin-top:14px; padding-top:8px; } .progress div { padding:4px 0; }
.error { color:var(--danger); margin-top:12px; }
.check-enter-active,.check-leave-active { transition: opacity .18s ease, transform .18s ease; }
.check-enter-from,.check-leave-to { opacity:0; transform:translateY(5px); }
</style>
