<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!-- A pending question or approval in the thread activity tray: expand it to answer in place. -->
<template>
  <div
    class="ta-item"
    :class="{ 'ta-open': open }"
  >
    <div
      class="ta-head"
      role="button"
      tabindex="0"
      :aria-expanded="open"
      @click="emit('toggle')"
      @keydown.enter.prevent="emit('toggle')"
      @keydown.space.prevent="emit('toggle')"
    >
      <span class="ta-chip ta-chip-you"><span class="ta-dot ta-dot-you" />Needs you</span>
      <span class="ta-name">{{ title }}</span>
      <span class="ta-last">{{ detail }}</span>
      <span class="ta-when">{{ when }}</span>
      <span class="ta-acts">
        <button
          type="button"
          class="ta-btn"
          @click.stop="emit('jump')"
        >Jump to card</button>
      </span>
    </div>
    <div
      v-if="open"
      class="ta-body ta-card"
    >
      <ToolQuestion
        v-if="msg.kind === 'tool_question'"
        :msg="msg"
      />
      <ToolApproval
        v-else
        :msg="msg"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import ToolApproval from '../tool/ToolApproval.vue';
import ToolQuestion from '../tool/ToolQuestion.vue';

import type { ToolApprovalMessage, ToolQuestionMessage } from '../../models/Message';

const props = defineProps<{ msg: ToolQuestionMessage | ToolApprovalMessage; open: boolean; when: string }>();
const emit = defineEmits<{ (e: 'toggle'): void; (e: 'jump'): void }>();

const title = computed(() => props.msg.kind === 'tool_question' ? (props.msg.questions[0]?.header || 'Question') : 'Approval');
const detail = computed(() => {
  const msg = props.msg;
  if (msg.kind === 'tool_approval') return msg.reason || msg.command;
  return msg.questions.length > 1 ? `${ msg.questions.length } questions to answer` : (msg.questions[0]?.question || 'waiting for your answer');
});
</script>

<style scoped src="../../styles/thread-status-line.css"></style>
