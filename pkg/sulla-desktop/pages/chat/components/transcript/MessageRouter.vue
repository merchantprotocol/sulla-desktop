<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!--
  MessageRouter — picks the right component for a given Message.kind.

  To add a new kind:
    1. Add a type in models/Message.ts
    2. Add a case below
    3. Done.

  The dedicated `<component :is>` switch keeps the transcript free of
  v-if ladders and keeps kinds orthogonal.
-->
<template>
  <TurnUser        v-if="msg.kind === 'user'"          :msg="msg" @edit="onEdit" />
  <TurnSulla       v-else-if="msg.kind === 'sulla'"    :msg="msg"
    @regenerate="controller.regenerate(msg.id)"
    @pin="controller.togglePin(msg.id)"
  />
  <TurnStreaming   v-else-if="msg.kind === 'streaming'" :msg="msg" />
  <TurnInterim     v-else-if="msg.kind === 'interim'"   :msg="msg" />
  <Thinking        v-else-if="msg.kind === 'thinking'"  :msg="msg" />
  <ToolCall        v-else-if="msg.kind === 'tool'"      :msg="msg" />
  <DecisionReference v-else-if="hasInboxRecord(msg)" :msg="msg" />
  <ToolApproval    v-else-if="msg.kind === 'tool_approval'" :msg="msg" />
  <ToolTask
    v-else-if="TaskAsks.isTask(msg)"    :msg="msg"
    :draft="questionDraft(msg)"
  />
  <ToolQuestion
    v-else-if="msg.kind === 'tool_question'" :msg="msg"
    :draft="questionDraft(msg)"
  />
  <PatchBlock      v-else-if="msg.kind === 'patch'"     :msg="msg" />
  <ChannelMessage  v-else-if="msg.kind === 'channel'"   :msg="msg" />
  <SubAgentBubble  v-else-if="msg.kind === 'subagent'"  :msg="msg" />
  <SubAgentExchange v-else-if="msg.kind === 'subagent_exchange'" :msg="msg" />
  <CitationRow     v-else-if="msg.kind === 'citation'"  :msg="msg" />
  <MemoryNote      v-else-if="msg.kind === 'memory'"    :msg="msg" />
  <ProactiveCard   v-else-if="msg.kind === 'proactive'" :msg="msg" />
  <HeartbeatMessage v-else-if="msg.kind === 'heartbeat'" :msg="msg" />
  <TtsIndicator    v-else-if="msg.kind === 'tts'"       :msg="msg" />
  <ErrorCard       v-else-if="msg.kind === 'error'"     :msg="msg" @action="onErrorAction" />
  <NoticeCard
    v-else-if="msg.kind === 'notice'"
    :msg="msg" @action="onErrorAction"
  />
  <div v-else />
</template>

<script setup lang="ts">
import DecisionReference from './DecisionReference.vue';
import ErrorCard       from './ErrorCard.vue';
import NoticeCard      from './NoticeCard.vue';
import TtsIndicator    from './TtsIndicator.vue';
import TurnInterim     from './TurnInterim.vue';
import TurnStreaming   from './TurnStreaming.vue';
import TurnSulla       from './TurnSulla.vue';
import TurnUser        from './TurnUser.vue';
import { ChatDecisions } from '../../composables/useChatDecisions';
import { useChatController } from '../../controller/useChatController';
import { TaskAsks } from '../../messages/taskAsk';
import ChannelMessage  from '../channel/ChannelMessage.vue';
import CitationRow     from '../citation/CitationRow.vue';
import HeartbeatMessage from '../heartbeat/HeartbeatMessage.vue';
import MemoryNote      from '../memory/MemoryNote.vue';
import PatchBlock      from '../patch/PatchBlock.vue';
import ProactiveCard   from '../proactive/ProactiveCard.vue';
import SubAgentBubble  from '../subagent/SubAgentBubble.vue';
import SubAgentExchange from '../subagent/SubAgentExchange.vue';
import Thinking        from '../thinking/Thinking.vue';
import ToolApproval    from '../tool/ToolApproval.vue';
import ToolCall        from '../tool/ToolCall.vue';
import ToolQuestion    from '../tool/ToolQuestion.vue';
import ToolTask        from '../tool/ToolTask.vue';
import type { Message } from '../../models/Message';

const props = defineProps<{ msg: Message }>();
const controller = useChatController();
const decisions = ChatDecisions.useChatDecisions();
function hasInboxRecord(message: Message): boolean {
  const id = message.kind === 'tool_question' ? message.questionId : message.kind === 'tool_approval' ? message.approvalId : undefined;
  return !!id && decisions.decisions.value.some(record => record.id === id);
}
function questionDraft(message: import('../../models/Message').ToolQuestionMessage) {
  return decisions.draft({ id: message.questionId ?? message.id, questions: [...message.questions] } as any);
}

function onEdit(): void {
  // Placeholder — a future EditMessageOverlay fires this; wire into
  // controller.editMessage(msg.id, newText) from there.
}

function onErrorAction(kind: 'retry' | 'continue' | 'dismiss' | 'connect'): void {
  if (kind === 'connect') window.dispatchEvent(new CustomEvent('sulla:open-ai-connections'));
}
void props;
</script>
