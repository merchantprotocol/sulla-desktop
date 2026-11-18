<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import PrefCard from '../PrefCard.vue';
import PrefRow from '../PrefRow.vue';
import PrefToggle from '../PrefToggle.vue';
import { useEngineSettings } from '@pkg/composables/preferences/useEngineSettings';
import { useThreatProtection } from '@pkg/composables/preferences/useThreatProtection';
const emit = defineEmits<{ (event: 'go', section: 'threat' | 'account' | 'files'): void }>();
const { get, set, isLocked } = useEngineSettings();
const threat = useThreatProtection();
const checkedAt = ref<Date>();
const checkError = ref('');
const checking = ref(false);
const checkItems = ref<{ label: string; passed: boolean; detail: string }[]>([]);
const hostAccess = computed(() => get('application.hostAccess') === true);
const threatState = computed(() => String(threat.status.value.state));
const protections = computed(() => [
  { label: 'Host access is off', passed: !hostAccess.value, detail: hostAccess.value ? 'Agents can run commands directly on this Mac.' : 'Commands remain inside Sulla’s sandbox.' },
  { label: 'Threat Protection is active', passed: threatState.value === 'running', detail: 'Threat proxy reports ' + threatState.value + '.' },
]);
const passedCount = computed(() => protections.value.filter(item => item.passed).length);
const status = computed(() => passedCount.value === protections.value.length ? 'Sulla is protected' : 'Sulla needs your attention');
async function runCheck() {
  checking.value = true; checkError.value = ''; checkItems.value = [];
  try {
    for (const item of protections.value) {
      await new Promise(resolve => setTimeout(resolve, 180));
      checkItems.value.push(item);
    }
    checkedAt.value = new Date();
  } catch (error) {
    checkError.value = error instanceof Error ? error.message : String(error);
  } finally { checking.value = false; }
}
function copyReport() {
  const report = ['Sulla security check — ' + (checkedAt.value?.toLocaleString() ?? 'not run'),
    ...checkItems.value.map(item => '[' + (item.passed ? 'PASS' : 'FAIL') + '] ' + item.label + ' — ' + item.detail)].join('\n');
  void navigator.clipboard?.writeText(report).catch(error => { checkError.value = error instanceof Error ? error.message : 'Clipboard access failed.'; });
}
function scrollTo(id: string) { document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
</script>
<template>
  <div class="security-section">
    <div class="ph"><div><h1>Security</h1><p>See how Sulla protects your work and credentials.</p></div></div>
    <section class="card security-status" :class="{ warning: passedCount < protections.length }">
      <div class="status-title"><span aria-hidden="true">{{ passedCount === protections.length ? '✓' : '!' }}</span><div><h2>{{ status }}</h2><p>{{ passedCount }} of {{ protections.length }} protections on<span v-if="checkedAt"> · Last checked {{ checkedAt.toLocaleTimeString() }}</span></p></div></div>
      <p v-if="passedCount < protections.length" class="security-warning">{{ protections.filter(item => !item.passed).map(item => item.detail).join(' · ') }}</p>
      <div class="security-chips"><button v-for="item in protections" :key="item.label" type="button" @click="scrollTo(item.label.includes('Host') ? 'security-sandbox' : 'security-threat')">{{ item.label }}</button></div>
      <button type="button" class="security-run" :disabled="checking" @click="runCheck">{{ checking ? 'Checking…' : 'Run security check' }}</button>
      <div v-if="checkError || threat.error.value" role="alert" class="security-error">Could not load security data: {{ checkError || threat.error.value }}</div>
      <div v-if="checkedAt" class="security-results" aria-live="polite"><p v-for="item in checkItems" :key="item.label">{{ item.passed ? '✓' : '!' }} {{ item.label }} — {{ item.detail }}</p><button type="button" @click="copyReport">Copy report</button></div>
    </section>
    <PrefCard id="security-sandbox" title="Sandbox" subtitle="Agents work inside Sulla’s isolated runtime unless you explicitly enable host access.">
      <PrefRow title="Let agents run commands on this Mac" :subtitle="hostAccess ? 'On: agents can run commands directly on this Mac, outside the sandbox.' : 'Off keeps all agent work inside Sulla’s sandbox.'">
        <PrefToggle :model-value="hostAccess" :disabled="isLocked('application.hostAccess')" label="Let agents run commands on this Mac" @update:model-value="set('application.hostAccess', $event)" />
      </PrefRow>
    </PrefCard>
    <PrefCard id="security-threat" title="Threat Protection" subtitle="Threat proxy status and traffic history are available in Threat Protection settings.">
      <PrefRow title="Proxy status" :subtitle="threatState"><button type="button" class="security-link" @click="emit('go', 'threat')">Open Threat Protection settings →</button></PrefRow>
    </PrefCard>
    <PrefCard title="Password vault" subtitle="Vault state is managed by the existing vault controls."><PrefRow title="Credentials" subtitle="Encrypted vault storage is used for saved credentials."><button type="button" class="security-link" @click="emit('go', 'account')">Open account &amp; vault settings →</button></PrefRow></PrefCard>
    <PrefCard title="File encryption" subtitle="Sulla Files uses AES-256-GCM encryption at rest."><PrefRow title="Sulla Files" subtitle="File history keeps recoverable earlier versions."><button type="button" class="security-link" @click="emit('go', 'files')">Open Files settings →</button></PrefRow></PrefCard>
    <PrefCard title="Approvals &amp; agent rules" subtitle="Use Case publishing requires approval in Decide. Security Conscience rules are available through Sulla rules tools." />
    <PrefCard title="Agent activity" subtitle="Recent activity is available in the Files audit trail."><p class="security-note">Activity is not shown here because this section does not yet have a bounded audit-data source.</p></PrefCard>
    <PrefCard title="Protected areas" subtitle="Vault material is protected by the encrypted password vault." />
    <PrefCard title="Usage data"><PrefRow title="Share anonymous usage statistics" subtitle="Never includes your files, chats or passwords."><PrefToggle :model-value="get('application.telemetry.enabled')" :disabled="isLocked('application.telemetry.enabled')" label="Share anonymous usage statistics" @update:model-value="set('application.telemetry.enabled', $event)" /></PrefRow></PrefCard>
  </div>
</template>
<style scoped>
.security-section { display: grid; gap: 16px; }
.security-status { padding: 18px; border: 1px solid var(--border-success); background: var(--bg-success); }
.security-status.warning { border-color: var(--border-warning); background: var(--bg-warning); }
.status-title { display: flex; align-items: center; gap: 12px; }
.status-title h2, .status-title p { margin: 0; }
.status-title p, .security-note { color: var(--text-muted); }
.status-title > span { color: var(--success); font-size: 24px; }
.warning .status-title > span, .security-warning { color: var(--warning); }
.security-chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0; }
.security-chips button, .security-results button, .security-run { border: 1px solid var(--border); border-radius: var(--radius-ctl); padding: 8px 12px; color: var(--text); background: var(--surface-1); cursor: pointer; }
.security-run { color: var(--text-on-accent); background: var(--accent); }
.security-run:disabled { opacity: .6; cursor: wait; }
.security-error { color: var(--danger); margin-top: 12px; }
.security-results { margin-top: 12px; border-top: 1px solid var(--border); padding-top: 8px; }
.security-link { color: var(--text-link); border: 0; background: transparent; cursor: pointer; }
</style>
