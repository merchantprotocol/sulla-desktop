<!-- Sulla Desktop · https://sulladesktop.com | Copyright (c) 2025-2026 Merchant Protocol LLC. | SPDX-License-Identifier: GPL-2.0-or-later | "Sulla" is a trademark. See TRADEMARK.md. -->
<template>
  <div class="max-w-lg mx-0 p-6 frm-page">
    <div class="fr-step-body">
    <h2 class="text-2xl font-bold mt-5 mb-2 frm-heading">Connect the AI you already use.</h2>
    <p class="mb-6 frm-subtext">Sign in to the account you already pay for. Each provider opens its own sign-in window. Sulla picks the default; you can change it later.</p>
    <div v-if="notice" class="frm-notice" :class="{ 'is-error': noticeKind === 'error' }" role="status">{{ notice }}</div>
    <div class="frm-options">
      <div v-for="provider in providers" :key="provider.id" class="frm-option">
        <img v-if="firstRunAiIconSrc(provider.icon)" :src="firstRunAiIconSrc(provider.icon)!" alt="" class="frm-option-icon">
        <span class="frm-option-text"><span class="frm-option-name">{{ provider.name }}</span><span class="frm-option-plan">{{ connectionState[provider.id] === 'connected' ? 'Connected' : provider.plan }}</span></span>
        <button type="button" class="frm-connect" :class="{ 'is-connected': connectionState[provider.id] === 'connected' }" :disabled="connectionState[provider.id] === 'connecting' || connectionState[provider.id] === 'waiting'" @click="connect(provider.id)"><span v-if="connectionState[provider.id] === 'connecting' || connectionState[provider.id] === 'waiting'" class="frm-spinner" aria-hidden="true" />{{ buttonLabel(provider.id) }}</button>
      </div>
    </div>
    <div v-if="showApiChoices && !hasConnection" class="frm-api">
      <p class="frm-notice">Choose a provider now. You'll paste your key in your vault right after setup.</p>
      <button v-for="provider in providers" :key="provider.id" type="button" class="frm-api-choice" @click="chooseApiProvider(provider.id)">Use {{ provider.name }} API</button>
    </div>
    </div>
    <div class="frm-actions">
      <button v-if="hasConnection" type="button" class="frm-btn-accent" @click="$emit('next')">Continue</button>
      <button v-if="!hasConnection" type="button" class="frm-btn-secondary" @click="showApiChoices = !showApiChoices">{{ showApiChoices ? 'Hide API choices' : 'Connect through API instead' }}</button>
      <button v-if="!hasConnection" type="button" class="frm-btn-later" @click="doLater">I'll do this later</button>
    </div>
  </div>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { FIRST_RUN_AI_PROVIDERS, firstRunAiIconSrc, type FirstRunAiProviderId } from './firstRunAiProviders';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
const emit = defineEmits<{ next: []; back: [] }>();
type ConnectState = 'idle' | 'waiting' | 'connecting' | 'connected';
const providers = FIRST_RUN_AI_PROVIDERS;
const connectionState = reactive<Record<FirstRunAiProviderId, ConnectState>>({ 'claude-code': 'idle', codex: 'idle', grok: 'idle' });
const showApiChoices = ref(false); const notice = ref(''); const noticeKind = ref<'info' | 'error'>('info');
let disposed = false; let claudeWaitTimer: ReturnType<typeof setTimeout> | undefined;
const hasConnection = computed(() => Object.values(connectionState).some(state => state === 'connected'));
function buttonLabel(id: FirstRunAiProviderId) { const state = connectionState[id]; return state === 'connected' ? 'Connected' : state === 'waiting' ? 'Waiting for Sulla…' : state === 'connecting' ? 'Connecting…' : 'Connect'; }
async function markConnected(id: FirstRunAiProviderId) { connectionState[id] = 'connected'; noticeKind.value = 'info'; notice.value = `${ providers.find(provider => provider.id === id)?.name } is connected. Sulla picked the default model for you.`; }
async function waitForClaudeThenConnect() { if (disposed || connectionState['claude-code'] !== 'waiting') return; const status = await ipcRenderer.invoke('first-run-ai:status' as any).catch(() => ({ ready: false })); if (status?.ready) { await runOAuth('claude-code'); return; } claudeWaitTimer = setTimeout(waitForClaudeThenConnect, 2_000); }
async function connect(id: FirstRunAiProviderId) { if (id === 'claude-code') { const status = await ipcRenderer.invoke('first-run-ai:status' as any).catch(() => ({ ready: false })); if (!status?.ready) { connectionState[id] = 'waiting'; noticeKind.value = 'info'; notice.value = "Claude needs Sulla's private workspace. We'll finish this in the background as soon as it's ready."; await waitForClaudeThenConnect(); return; } } await runOAuth(id); }
async function runOAuth(id: FirstRunAiProviderId, automaticRetry = true) {
  connectionState[id] = 'connecting'; noticeKind.value = 'info';
  notice.value = id === 'claude-code' ? 'Getting Claude ready… the first time can take a minute.' : '';
  const result = id === 'claude-code' ? await ipcRenderer.invoke('claude-oauth:start', { firstRun: true } as any).then(value => ({ success: Boolean(value?.success), error: value?.error })) : await ipcRenderer.invoke('integration-oauth:start', { integrationId: id, providerId: id, accountId: 'oauth', firstRun: true });
  if (result?.success) { await ipcRenderer.invoke('first-run-ai:connected', id); await markConnected(id); return; }
  connectionState[id] = 'idle'; const name = providers.find(provider => provider.id === id)?.name || 'The provider';
  if (automaticRetry && !disposed) { noticeKind.value = 'info'; notice.value = `${ name } didn't finish signing in. The window may have closed or the callback didn't return. Trying again automatically — you won't restart setup.`; await new Promise(resolve => setTimeout(resolve, 1_500)); if (!disposed) await runOAuth(id, false); return; }
  noticeKind.value = 'error'; notice.value = `${ name } still didn't finish signing in${ result?.error ? `: ${ result.error }` : '.' } Nothing was lost — use Connect to retry or choose another provider.`;
}
function onClaudeStage(_event: unknown, text: string) {
  if (connectionState['claude-code'] === 'connecting' && typeof text === 'string') { noticeKind.value = 'info'; notice.value = text; }
}
onMounted(() => ipcRenderer.on('claude-oauth:stage' as any, onClaudeStage));
onBeforeUnmount(() => ipcRenderer.removeListener('claude-oauth:stage' as any, onClaudeStage));
async function doLater() { emit('next'); }
async function chooseApiProvider(id: FirstRunAiProviderId) {
  const integrationId = id === 'claude-code' ? 'anthropic' : id === 'codex' ? 'openai' : 'grok';
  const current = await ipcRenderer.invoke('first-run-state:get' as any).catch(() => ({ choices: {} }));
  await ipcRenderer.invoke('first-run-state:set' as any, { choices: { ...(current?.choices || {}), aiApiProvider: integrationId } });
  noticeKind.value = 'info';
  notice.value = `We'll open ${ providers.find(provider => provider.id === id)?.name } in your vault right after setup.`;
  emit('next');
}
onBeforeUnmount(() => { disposed = true; if (claudeWaitTimer) clearTimeout(claudeWaitTimer); });
</script>
<style lang="scss" scoped>
.frm-page{display:flex;flex-direction:column;height:100%;min-height:0}.fr-step-body{min-height:0;overflow-y:auto}
.frm-page{color:var(--text-primary)}.frm-heading{font-family:"Playfair Display",Georgia,serif;font-size:34px;line-height:1.08}.frm-subtext,.frm-option-plan{color:var(--text-muted)}.frm-options,.frm-api{display:flex;flex-direction:column;gap:9px}.frm-option{display:flex;align-items:center;gap:13px;min-height:66px;padding:12px 14px;border:1px solid var(--border-default);border-radius:14px;background:var(--bg-input)}.frm-option-icon{width:30px;height:30px}.frm-option-text{display:flex;flex:1;flex-direction:column;gap:2px}.frm-option-name{font-weight:650}.frm-option-plan{font-size:13px}.frm-connect,.frm-api-choice{padding:8px 15px;border-radius:9px;background:var(--accent-primary);color:var(--text-on-accent);font-weight:650}.frm-connect.is-connected{background:var(--bg-surface-hover);color:var(--text-secondary)}button:disabled{cursor:wait;opacity:.65}.frm-notice{margin-bottom:12px;padding:11px 13px;border:1px solid var(--border-default);border-radius:10px;color:var(--text-secondary);background:var(--bg-surface-alt);font-size:13px;line-height:1.45}.frm-notice.is-error{border-color:var(--border-error);color:var(--text-error);background:var(--bg-error)}.frm-api-row{display:flex;flex-direction:column;gap:6px;font-weight:600}.frm-api-input{display:flex;gap:8px}.frm-api-input input{min-width:0;flex:1;padding:9px 11px;border:1px solid var(--border-default);border-radius:9px;background:var(--bg-input);color:var(--text-primary);font-weight:400}.frm-actions{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:20px}.frm-actions button{padding:9px 14px;border-radius:9px;font-weight:600}.frm-btn-accent{background:var(--accent-primary);color:var(--text-on-accent)}.frm-btn-secondary{background:var(--bg-surface-hover);color:var(--text-primary)}.frm-btn-later{color:var(--text-muted)}.theme-noir .frm-option{border-color:transparent;background:rgb(from var(--nx-paper) calc(r + 2) calc(g + 3) calc(b + 2)/.4);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--nx-accent-2) 12%,transparent)}.theme-noir .frm-connect,.theme-noir .frm-api-choice,.theme-noir .frm-btn-accent{background:var(--nx-accent);color:var(--nx-ink)}
.frm-spinner{display:inline-block;width:12px;height:12px;margin-right:6px;vertical-align:-1px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:frm-spin .8s linear infinite}@keyframes frm-spin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion: reduce){.frm-spinner{animation-duration:2s}}
</style>
