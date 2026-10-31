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
        <button type="button" class="frm-connect" :class="{ 'is-connected': connectionState[provider.id] === 'connected' }" :disabled="isBusy(provider.id)" @click="connect(provider.id)"><span v-if="isBusy(provider.id)" class="frm-spinner" aria-hidden="true" />{{ buttonLabel(provider.id) }}</button>
        <button v-if="isBusy(provider.id)" type="button" class="frm-cancel" @click="cancel(provider.id)">Cancel</button>
      </div>
    </div>
    <div v-if="showApiChoices && !hasConnection" class="frm-api">
      <p class="frm-notice">Choose a provider now. You'll paste your key in your vault right after setup.</p>
      <button v-for="provider in providers" :key="provider.id" type="button" class="frm-api-choice" :disabled="advancing" @click="chooseApiProvider(provider.id)">Use {{ provider.name }} API</button>
    </div>
    </div>
    <div class="frm-actions">
      <button v-if="hasConnection" type="button" class="frm-btn-accent" :disabled="advancing" @click="advance">Continue</button>
      <button v-if="!hasConnection" type="button" class="frm-btn-secondary" :disabled="advancing" @click="showApiChoices = !showApiChoices">{{ showApiChoices ? 'Hide API choices' : 'Connect through API instead' }}</button>
      <button v-if="!hasConnection" type="button" class="frm-btn-later" :disabled="advancing" @click="doLater">I'll do this later</button>
    </div>
  </div>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { FIRST_RUN_AI_PROVIDERS, firstRunAiIconSrc, type FirstRunAiProviderId } from './firstRunAiProviders';
import { traceFirstRun } from './firstRunWizard';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
const emit = defineEmits<{ next: [from?: number]; back: [from?: number] }>();
const props = defineProps<{ stepIndex?: number }>();
type ConnectState = 'idle' | 'waiting' | 'connecting' | 'connected';
// Why a sign-in failed, from claude-oauth:start / integration-oauth:start.
type FailureReason = 'user-closed' | 'timeout' | 'offline' | 'cli-missing' | 'vm-not-ready' | 'provider-error';
const providers = FIRST_RUN_AI_PROVIDERS;
const connectionState = reactive<Record<FirstRunAiProviderId, ConnectState>>({ 'claude-code': 'idle', codex: 'idle', grok: 'idle' });
const showApiChoices = ref(false); const notice = ref(''); const noticeKind = ref<'info' | 'error'>('info');
const advancing = ref(false);
let disposed = false; let claudeWaitTimer: ReturnType<typeof setTimeout> | undefined;
// Each Connect click is one attempt. Cancel or a new click retires the old
// one, so its late result can't change the screen.
const attempts: Record<FirstRunAiProviderId, number> = { 'claude-code': 0, codex: 0, grok: 0 };
// Main's own limit is 5 minutes. Past this the screen gives up on its own.
const CONNECT_TIMEOUT_MS = 6 * 60_000;
// How often to ask main whether the sign-in already landed, in case the
// start call itself never answers.
const CONNECT_POLL_MS = 3_000;
function isBusy(id: FirstRunAiProviderId) { return connectionState[id] === 'connecting' || connectionState[id] === 'waiting'; }
const hasConnection = computed(() => Object.values(connectionState).some(state => state === 'connected'));
function providerName(id: FirstRunAiProviderId) { return providers.find(provider => provider.id === id)?.name || 'The provider'; }
function buttonLabel(id: FirstRunAiProviderId) { const state = connectionState[id]; return state === 'connected' ? 'Connected' : state === 'waiting' ? 'Waiting for Sulla…' : state === 'connecting' ? 'Connecting…' : 'Connect'; }
async function markConnected(id: FirstRunAiProviderId) { connectionState[id] = 'connected'; noticeKind.value = 'info'; notice.value = `${ providerName(id) } is connected. Sulla picked the default model for you.`; }
async function waitForClaudeThenConnect() { if (disposed || connectionState['claude-code'] !== 'waiting') return; const status = await ipcRenderer.invoke('first-run-ai:status' as any).catch(() => ({ ready: false })); if (disposed || connectionState['claude-code'] !== 'waiting') return; if (status?.ready) { await runOAuth('claude-code'); return; } claudeWaitTimer = setTimeout(waitForClaudeThenConnect, 2_000); }
async function connect(id: FirstRunAiProviderId) {
  if (connectionState[id] !== 'idle' || advancing.value) return;
  traceFirstRun('ai', 'Connect clicked', { provider: id });
  if (id === 'claude-code') { connectionState[id] = 'waiting'; const status = await ipcRenderer.invoke('first-run-ai:status' as any).catch(() => ({ ready: false })); if (connectionState[id] !== 'waiting') return; if (!status?.ready) { traceFirstRun('ai', 'waiting for the workspace before Claude sign-in'); noticeKind.value = 'info'; notice.value = "Claude needs Sulla's private workspace. We'll finish this in the background as soon as it's ready."; await waitForClaudeThenConnect(); return; } }
  await runOAuth(id);
}
function cancel(id: FirstRunAiProviderId) {
  traceFirstRun('ai', 'Cancel clicked', { provider: id, state: connectionState[id] });
  attempts[id]++;
  if (id === 'claude-code') { if (claudeWaitTimer) clearTimeout(claudeWaitTimer); void ipcRenderer.invoke('claude-oauth:cancel').catch(() => undefined); }
  connectionState[id] = 'idle'; noticeKind.value = 'info';
  notice.value = `${ providerName(id) } sign-in cancelled. Use Connect to try again, or pick another option.`;
}
/** True once main holds a sign-in for this provider, whatever the start call says. */
async function signInLanded(id: FirstRunAiProviderId): Promise<boolean> {
  const status = await ipcRenderer.invoke('first-run-ai:connection-status' as any).catch(() => null);
  return Array.isArray(status?.pending) && status.pending.includes(id);
}
/**
 * Resolve with the start call's result, or earlier when main already holds the
 * sign-in, the user cancelled, or the screen's own deadline passes.
 */
function watchSignIn(id: FirstRunAiProviderId, attempt: number, start: Promise<OAuthResult>): Promise<OAuthResult | 'cancelled'> {
  return new Promise((resolve) => {
    let poll: ReturnType<typeof setInterval> | undefined;
    const deadline = setTimeout(() => finish({ success: false, error: 'Sign-in is taking too long.', reason: 'timeout' }), CONNECT_TIMEOUT_MS);
    const finish = (result: OAuthResult | 'cancelled') => { clearTimeout(deadline); if (poll) clearInterval(poll); resolve(result); };
    poll = setInterval(async() => {
      if (attempts[id] !== attempt || disposed) { finish('cancelled'); return; }
      if (await signInLanded(id)) { traceFirstRun('ai', 'main holds the sign-in before the start call answered', { provider: id }); finish({ success: true }); }
    }, CONNECT_POLL_MS);
    start.then(finish, (err: unknown) => finish({ success: false, error: err instanceof Error ? err.message : String(err) }));
  });
}
function failureMessage(id: FirstRunAiProviderId, reason: FailureReason | undefined, error: string | undefined) {
  const name = providerName(id);
  if (reason === 'user-closed') return `${ name } sign-in was closed. Use Connect to try again, or pick another option.`;
  if (reason === 'timeout') return `${ name } sign-in took too long. Use Connect to try again, or pick another option.`;
  if (reason === 'offline') return `${ name } couldn't be reached. Check your connection, then use Connect to try again.`;
  if (reason === 'vm-not-ready' || reason === 'cli-missing') return `Sulla's workspace isn't ready for ${ name } yet. Wait a moment, then use Connect to try again.`;
  return `${ name } didn't finish signing in${ error ? `: ${ error }` : '.' } Nothing was lost. Use Connect to retry or choose another option.`;
}
type OAuthResult = { success?: boolean; error?: string; reason?: FailureReason };
async function runOAuth(id: FirstRunAiProviderId, automaticRetry = true) {
  const attempt = ++attempts[id];
  connectionState[id] = 'connecting'; noticeKind.value = 'info';
  notice.value = id === 'claude-code' ? 'Getting Claude ready… the first time can take a minute.' : `Finish signing in to ${ providerName(id) } in the window that opens.`;
  let result: OAuthResult | 'cancelled' | undefined;
  try {
    const start: Promise<OAuthResult> = id === 'claude-code'
      ? ipcRenderer.invoke('claude-oauth:start', { firstRun: true } as any)
      : ipcRenderer.invoke('integration-oauth:start', { integrationId: id, providerId: id, accountId: 'oauth', firstRun: true });
    result = await watchSignIn(id, attempt, start);
    traceFirstRun('ai', 'sign-in finished', result === 'cancelled' ? { provider: id, result } : { provider: id, success: !!result?.success, reason: result?.reason, error: result?.error });
    // Cancelled, or a newer attempt owns the button now.
    if (result === 'cancelled' || attempts[id] !== attempt) return;
    if (result?.success) {
      // The token is held in main either way; a failed bookkeeping call must not hide the connection.
      await ipcRenderer.invoke('first-run-ai:connected', id).catch((err: unknown) => console.warn('[FirstRunRemoteModel] first-run-ai:connected failed:', err));
      await markConnected(id);
      return;
    }
  } catch (err) {
    result = { success: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    // Never leave "Connecting…" stuck, whatever happened above.
    if (attempts[id] === attempt && connectionState[id] === 'connecting') connectionState[id] = 'idle';
  }
  if (disposed || result === 'cancelled' || attempts[id] !== attempt) return;
  // Only a timeout or a provider hiccup retries by itself. If the user closed
  // the window, they meant it.
  if (automaticRetry && (result?.reason === 'timeout' || result?.reason === 'provider-error')) {
    traceFirstRun('ai', 'retrying sign-in once by itself', { provider: id, reason: result?.reason });
    noticeKind.value = 'info'; notice.value = `${ providerName(id) } didn't finish signing in. Trying once more…`;
    await new Promise(resolve => setTimeout(resolve, 1_500));
    if (!disposed && connectionState[id] === 'idle') await runOAuth(id, false);
    return;
  }
  noticeKind.value = result?.reason === 'user-closed' ? 'info' : 'error';
  notice.value = failureMessage(id, result?.reason, result?.error);
}
function onClaudeStage(_event: unknown, text: string) {
  if (connectionState['claude-code'] === 'connecting' && typeof text === 'string' && text) { noticeKind.value = 'info'; notice.value = text; }
}
onMounted(async() => {
  ipcRenderer.on('claude-oauth:stage' as any, onClaudeStage);
  // Sign-ins from before a reload are still held in main. Show them.
  try {
    const status = await ipcRenderer.invoke('first-run-ai:connection-status' as any);
    const pending: string[] = Array.isArray(status?.pending) ? status.pending : [];
    for (const provider of providers) {
      if (pending.includes(provider.id) && connectionState[provider.id] === 'idle') connectionState[provider.id] = 'connected';
    }
    if (pending.length) traceFirstRun('ai', 'showing sign-ins main already holds', { pending });
  } catch { /* nothing to restore */ }
});
onBeforeUnmount(() => ipcRenderer.removeListener('claude-oauth:stage' as any, onClaudeStage));
function advance() { if (advancing.value) return; advancing.value = true; traceFirstRun('ai', 'Continue clicked', { connected: providers.filter(p => connectionState[p.id] === 'connected').map(p => p.id) }); emit('next', props.stepIndex); }
async function doLater() { if (advancing.value) return; advancing.value = true; traceFirstRun('ai', "I'll do this later clicked"); emit('next', props.stepIndex); }
async function chooseApiProvider(id: FirstRunAiProviderId) {
  if (advancing.value) return;
  advancing.value = true;
  const integrationId = id === 'claude-code' ? 'anthropic' : id === 'codex' ? 'openai' : 'grok';
  traceFirstRun('ai', 'API choice clicked', { provider: integrationId });
  try {
    const current = await ipcRenderer.invoke('first-run-state:get' as any).catch(() => ({ choices: {} }));
    await ipcRenderer.invoke('first-run-state:set' as any, { choices: { ...(current?.choices || {}), aiApiProvider: integrationId } });
  } catch (err) {
    console.warn('[FirstRunRemoteModel] Could not save the API choice:', err);
  }
  noticeKind.value = 'info';
  notice.value = `We'll open ${ providerName(id) } in your vault right after setup.`;
  emit('next', props.stepIndex);
}
onBeforeUnmount(() => {
  disposed = true;
  if (claudeWaitTimer) clearTimeout(claudeWaitTimer);
  // Leaving mid sign-in: stop Claude's sign-in in the VM too.
  if (isBusy('claude-code')) void ipcRenderer.invoke('claude-oauth:cancel').catch(() => undefined);
});
</script>
<style lang="scss" scoped>
.frm-page{display:flex;flex-direction:column;height:100%;min-height:0}.fr-step-body{min-height:0;overflow-y:auto}
.frm-page{color:var(--text-primary)}.frm-heading{font-family:"Playfair Display",Georgia,serif;font-size:34px;line-height:1.08}.frm-subtext,.frm-option-plan{color:var(--text-muted)}.frm-options,.frm-api{display:flex;flex-direction:column;gap:9px}.frm-option{display:flex;align-items:center;gap:13px;min-height:66px;padding:12px 14px;border:1px solid var(--border-default);border-radius:14px;background:var(--bg-input)}.frm-option-icon{width:30px;height:30px}.frm-option-text{display:flex;flex:1;flex-direction:column;gap:2px}.frm-option-name{font-weight:650}.frm-option-plan{font-size:13px}.frm-connect,.frm-api-choice{padding:8px 15px;border-radius:9px;background:var(--accent-primary);color:var(--text-on-accent);font-weight:650}.frm-cancel{padding:8px 12px;border-radius:9px;color:var(--text-muted);font-weight:600}.frm-connect.is-connected{background:var(--bg-surface-hover);color:var(--text-secondary)}button:disabled{cursor:wait;opacity:.65}.frm-notice{margin-bottom:12px;padding:11px 13px;border:1px solid var(--border-default);border-radius:10px;color:var(--text-secondary);background:var(--bg-surface-alt);font-size:13px;line-height:1.45}.frm-notice.is-error{border-color:var(--border-error);color:var(--text-error);background:var(--bg-error)}.frm-api-row{display:flex;flex-direction:column;gap:6px;font-weight:600}.frm-api-input{display:flex;gap:8px}.frm-api-input input{min-width:0;flex:1;padding:9px 11px;border:1px solid var(--border-default);border-radius:9px;background:var(--bg-input);color:var(--text-primary);font-weight:400}.frm-actions{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:20px}.frm-actions button{padding:9px 14px;border-radius:9px;font-weight:600}.frm-btn-accent{background:var(--accent-primary);color:var(--text-on-accent)}.frm-btn-secondary{background:var(--bg-surface-hover);color:var(--text-primary)}.frm-btn-later{color:var(--text-muted)}.theme-noir .frm-option{border-color:transparent;background:rgb(from var(--nx-paper) calc(r + 2) calc(g + 3) calc(b + 2)/.4);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--nx-accent-2) 12%,transparent)}.theme-noir .frm-connect,.theme-noir .frm-api-choice,.theme-noir .frm-btn-accent{background:var(--nx-accent);color:var(--nx-ink)}
.frm-spinner{display:inline-block;width:12px;height:12px;margin-right:6px;vertical-align:-1px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:frm-spin .8s linear infinite}@keyframes frm-spin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion: reduce){.frm-spinner{animation-duration:2s}}
</style>
