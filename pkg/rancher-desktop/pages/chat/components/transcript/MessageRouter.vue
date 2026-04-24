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
  <ToolApproval    v-else-if="msg.kind === 'tool_approval'" :msg="msg" />
  <PatchBlock      v-else-if="msg.kind === 'patch'"     :msg="msg" />
  <ChannelMessage  v-else-if="msg.kind === 'channel'"   :msg="msg" />
  <SubAgentBubble  v-else-if="msg.kind === 'subagent'"  :msg="msg" />
  <CitationRow     v-else-if="msg.kind === 'citation'"  :msg="msg" />
  <MemoryNote      v-else-if="msg.kind === 'memory'"    :msg="msg" />
  <ProactiveCard   v-else-if="msg.kind === 'proactive'" :msg="msg" />
  <TtsIndicator    v-else-if="msg.kind === 'tts'"       :msg="msg" />
  <ErrorCard       v-else-if="msg.kind === 'error'"     :msg="msg" />
  <div v-else />
</template>

<script setup lang="ts">
import type { Message } from '../../models/Message';
import { useChatController } from '../../controller/useChatController';

import TurnUser        from './TurnUser.vue';
import TurnSulla       from './TurnSulla.vue';
import TurnStreaming   from './TurnStreaming.vue';
import TurnInterim     from './TurnInterim.vue';
import Thinking        from '../thinking/Thinking.vue';
import ToolCall        from '../tool/ToolCall.vue';
import ToolApproval    from '../tool/ToolApproval.vue';
import PatchBlock      from '../patch/PatchBlock.vue';
import ChannelMessage  from '../channel/ChannelMessage.vue';
import SubAgentBubble  from '../subagent/SubAgentBubble.vue';
import CitationRow     from '../citation/CitationRow.vue';
import MemoryNote      from '../memory/MemoryNote.vue';
import ProactiveCard   from '../proactive/ProactiveCard.vue';
import TtsIndicator    from './TtsIndicator.vue';
import ErrorCard       from './ErrorCard.vue';

const props = defineProps<{ msg: Message }>();
const controller = useChatController();

function onEdit(): void {
  // Placeholder — a future EditMessageOverlay fires this; wire into
  // controller.editMessage(msg.id, newText) from there.
}
void props;
</script>
