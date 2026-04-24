<!--
  Inline approval card. When the decision is settled, the buttons
  disappear and a status tag appears.
-->
<template>
  <div :class="['approval', decisionClass]">
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
  border: 1px solid rgba(252, 211, 77, 0.35);
  border-radius: 10px;
  background: rgba(252, 211, 77, 0.04);
  position: relative;
}
.head {
  font-family: var(--mono); font-size: 10px; letter-spacing: 0.22em;
  text-transform: uppercase; color: var(--warn);
  margin-bottom: 8px;
  display: flex; align-items: center; gap: 10px;
}
.head::before {
  content: "!"; width: 18px; height: 18px; border-radius: 50%;
  background: var(--warn); color: #1a1200;
  display: inline-flex; align-items: center; justify-content: center;
  font-weight: 900; font-size: 11px;
}
.what {
  font-family: var(--serif); font-style: italic; font-size: 16px;
  color: var(--read-1); line-height: 1.55; margin-bottom: 12px;
}
.cmd {
  font-family: var(--mono); font-size: 12px;
  background: rgba(252, 211, 77, 0.08);
  padding: 10px 14px; border-radius: 6px;
  border: 1px solid rgba(252, 211, 77, 0.2);
  color: var(--read-1); margin-bottom: 14px;
  overflow-x: auto; white-space: nowrap;
}
.actions { display: flex; gap: 10px; }
.actions button {
  padding: 8px 16px; border-radius: 6px;
  font-family: var(--mono); font-size: 10.5px;
  letter-spacing: 0.22em; text-transform: uppercase;
  cursor: pointer; transition: all 0.15s ease; border: 1px solid transparent;
}
.actions .approve {
  background: var(--steel-500); color: white; border-color: var(--steel-400);
}
.actions .approve:hover {
  background: var(--steel-400);
  box-shadow: 0 0 18px rgba(106, 176, 204, 0.45);
}
.actions .deny {
  background: transparent; color: var(--read-3);
  border-color: rgba(168, 192, 220, 0.22);
}
.actions .deny:hover {
  color: var(--err); border-color: var(--err); background: rgba(252, 165, 165, 0.08);
}
.approval.settled { opacity: 0.6; }
.approval.approved::after,
.approval.denied::after {
  position: absolute; bottom: 14px; right: 20px;
  font-family: var(--mono); font-size: 10px; letter-spacing: 0.22em;
  text-transform: uppercase;
}
.approval.approved::after { content: "◆ APPROVED"; color: var(--ok); }
.approval.denied::after   { content: "◇ DENIED"; color: var(--err); }
</style>
