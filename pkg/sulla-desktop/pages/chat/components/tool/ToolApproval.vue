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
    <div class="head">Approval required</div>
    <div class="what">{{ msg.reason }}</div>
    <div class="cmd">{{ msg.command }}</div>
    <div v-if="msg.decision === 'pending'" class="actions">
      <button class="approve" type="button" @click="controller.approveTool(msg.id)">Approve</button>
      <button class="deny"    type="button" @click="controller.denyTool(msg.id)">Deny</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { ToolApprovalMessage } from '../../models/Message';
import { useChatController } from '../../controller/useChatController';

const props = defineProps<{ msg: ToolApprovalMessage }>();
const controller = useChatController();
const decisionClass = computed(() => {
  if (props.msg.decision === 'approved') return 'settled approved';
  if (props.msg.decision === 'denied')   return 'settled denied';
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
