<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!--
  Inline approval card. When the decision is settled, the buttons
  disappear and a status tag appears.
-->
<template>
  <div :class="['approval', decisionClass]">
    <p v-if="msg.resolutionError" role="alert">{{ msg.resolutionError }}</p>
    <div class="head">{{ msg.title || 'Approval required' }}</div>
    <div class="what">{{ msg.reason }}</div>
    <div class="cmd">{{ msg.command }}</div>
    <p v-if="expiresAtLabel" class="expires">Expires {{ expiresAtLabel }}</p>
    <p v-if="effectiveDecision === 'timed_out'" role="status">{{ effectiveStateLabel }}</p>
    <div v-if="effectiveDecision === 'pending'" class="actions">
      <button class="approve" type="button" :disabled="blocked" @click="settle('approved')">Approve</button>
      <button class="deny"    type="button" :disabled="blocked" @click="settle('denied')">Deny</button>
    </div>
    <button v-if="showDecideLink" class="open-decide" type="button" @click="openDecide">Open in Decide</button>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { ToolApprovalMessage } from '../../models/Message';
import { useChatController } from '../../controller/useChatController';

const props = defineProps<{ msg: ToolApprovalMessage; blocked?: boolean; stateLabel?: string; decide?: (action: 'approved' | 'denied') => Promise<void>; showDecideLink?: boolean }>();
const controller = useChatController();
const now = ref(Date.now());
let expiryTimer: ReturnType<typeof setInterval> | undefined;
const effectiveDecision = computed(() => props.msg.decision === 'pending' && props.msg.expiresAt !== undefined && props.msg.expiresAt <= now.value
  ? 'timed_out'
  : props.msg.decision);
const expiresAtLabel = computed(() => props.msg.expiresAt === undefined
  ? undefined
  : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(props.msg.expiresAt)));
const effectiveStateLabel = computed(() => effectiveDecision.value === 'timed_out' && props.msg.expiresAt !== undefined && props.msg.expiresAt <= now.value
  ? 'Expired'
  : props.stateLabel || 'Timed out');
onMounted(() => {
  if (props.msg.expiresAt === undefined) return;
  expiryTimer = setInterval(() => {
    now.value = Date.now();
    if (props.msg.expiresAt !== undefined && props.msg.expiresAt <= now.value && expiryTimer) {
      clearInterval(expiryTimer);
      expiryTimer = undefined;
    }
  }, 1000);
});
onBeforeUnmount(() => { if (expiryTimer) clearInterval(expiryTimer) });
function settle(action: 'approved' | 'denied'): void {
  if (props.blocked || effectiveDecision.value !== 'pending') return;
  if (props.decide) void props.decide(action);
  else if (action === 'approved') controller.approveTool(props.msg.id);
  else controller.denyTool(props.msg.id);
}
function openDecide(): void {
  window.dispatchEvent(new CustomEvent('sulla:mode-rail-select', { detail: { mode: 'decide' } }));
}
const decisionClass = computed(() => {
  if (effectiveDecision.value === 'approved') return 'settled approved';
  if (effectiveDecision.value === 'denied')   return 'settled denied';
  return '';
});
</script>

<style scoped>
.approval {
  padding: 16px 20px; margin: 4px 0;
  border: 1px solid var(--status-warning);
  border-radius: 10px;
  background: var(--status-warning-soft);
  position: relative;
}
.head {
  font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.22em;
  text-transform: uppercase; color: var(--status-warning);
  margin-bottom: 8px;
  display: flex; align-items: center; gap: 10px;
}
.head::before {
  content: "!"; width: 18px; height: 18px; border-radius: 50%;
  background: var(--status-warning); color: var(--status-warning);
  display: inline-flex; align-items: center; justify-content: center;
  font-weight: 900; font-size: 11px;
}
.what {
  font-family: var(--font-display); font-style: italic; font-size: 16px;
  color: var(--text-primary); line-height: 1.55; margin-bottom: 12px;
}
.expires { margin: -5px 0 14px; color: var(--text-secondary); font-size: 12px; }
.cmd {
  font-family: var(--font-mono); font-size: 12px;
  background: var(--status-warning-soft);
  padding: 10px 14px; border-radius: 6px;
  border: 1px solid var(--status-warning-soft);
  color: var(--text-primary); margin-bottom: 14px;
  overflow-x: auto; white-space: nowrap;
}
.actions { display: flex; gap: 10px; }
.actions button {
  padding: 8px 16px; border-radius: 6px;
  font-family: var(--font-mono); font-size: 10.5px;
  letter-spacing: 0.22em; text-transform: uppercase;
  cursor: pointer; transition: all 0.15s ease; border: 1px solid transparent;
}
.actions .approve {
  background: var(--accent); color: var(--text-on-accent); border-color: var(--accent-hover);
}
.actions .approve:hover {
  background: var(--accent-hover);
  box-shadow: 0 0 18px var(--accent-glow);
}
.actions .deny {
  background: transparent; color: var(--text-secondary);
  border-color: var(--accent-dim);
}
.actions .deny:hover {
  color: var(--status-error); border-color: var(--status-error); background: var(--status-warning-soft);
}
.open-decide {
  margin-top: 12px; padding: 0; border: 0; background: none; color: var(--accent);
  font: inherit; font-size: 12px; text-decoration: underline; text-underline-offset: 3px; cursor: pointer;
}
.approval.settled { opacity: 0.6; }
.approval.approved::after,
.approval.denied::after {
  position: absolute; bottom: 14px; right: 20px;
  font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.22em;
  text-transform: uppercase;
}
.approval.approved::after { content: "◆ APPROVED"; color: var(--status-success); }
.approval.denied::after   { content: "◇ DENIED"; color: var(--status-error); }
</style>
