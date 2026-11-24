<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<template>
  <div class="chat-root chat-fixture">
    <ModeRail active="chat" />
    <section class="chat-main">
      <header>
        <strong>Sulla</strong>
        <span>Studio theme review</span>
        <button class="fixture-run" type="button" @click="toggleRun">{{ controller.isRunning.value ? 'Stop preview run' : 'Preview running state' }}</button>
      </header>
      <div class="transcript">
        <div class="user"><b>You</b><p>Show me how the real Capsule composer handles this conversation.</p></div>
        <div class="assistant"><b>Sulla</b><div class="markdown"><h2>Theme preview</h2><p>This fixture mounts the production chat composer and the real chat controller. It keeps the transcript illustrative and does not send anything to a service.</p><ul><li>Theme tokens update live</li><li>Preview running state toggles the Capsule halo</li></ul></div></div>
        <div class="assistant"><b>Sulla · HTML</b><article class="html-card"><h3>Preview ready</h3><p>The composer below is the actual <code>Composer.vue</code>, not a static mock.</p></article></div>
      </div>
      <Composer :reporting-level="'debug'" />
    </section>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, provide, ref } from 'vue';
import ModeRail from '@pkg/pages/chat/components/chrome/ModeRail.vue';
import Composer from '@pkg/pages/chat/components/composer/Composer.vue';
import { ChatController } from '@pkg/pages/chat/controller/ChatController';
import { provideChatController } from '@pkg/pages/chat/controller/useChatController';
import { AGENT_STATE_CLIENT_KEY } from '@pkg/services/agentState/AgentStateInjection';
import type { AgentStateClient } from '@pkg/services/agentState/AgentStateClient';

const controller = new ChatController();
provideChatController(controller);
provide(AGENT_STATE_CLIENT_KEY, { snapshot: ref({ rows: [] }) } as unknown as AgentStateClient);
provide('chat:activity-context', { backendThreadId: ref(undefined) });
provide('chat:is-active', ref(true));

function toggleRun(): void {
  if (controller.isRunning.value) controller.stop();
  else controller.send('Local theme-preview run.');
}

onBeforeUnmount(() => controller.dispose());
</script>

<style scoped>
.chat-fixture { height: 100%; display: flex; background: var(--bg-surface); color: var(--text-primary); }
.chat-main { position: relative; min-width: 0; flex: 1; display: grid; grid-template-rows: 54px minmax(0, 1fr); }
.chat-main > header { display: flex; align-items: center; gap: 14px; padding: 0 22px; border-bottom: 1px solid var(--border-default); }
.chat-main > header span { color: var(--text-muted); }
.fixture-run { margin-left: auto; padding: 6px 10px; border: 1px solid var(--border-default); border-radius: 8px; color: var(--text-secondary); background: var(--bg-surface); cursor: pointer; }
.fixture-run:hover { border-color: var(--accent); }
.transcript { width: min(820px, calc(100% - 48px)); min-width: 0; margin: 0 auto; padding: 36px 0 180px; display: grid; align-content: start; gap: 28px; overflow: auto; }
.user { justify-self: end; max-width: 72%; text-align: right; }
.user p { padding: 16px 20px; border-radius: 22px; background: var(--bg-surface-alt); text-align: left; }
.assistant { max-width: 78%; }
.assistant b, .user b { font-size: 12px; color: var(--text-muted); }
.markdown { line-height: 1.55; }
.html-card { margin-top: 8px; padding: 18px; border: 1px solid var(--border-default); border-radius: 14px; background: var(--bg-surface); }
.html-card h3 { margin-top: 0; }
@media (max-width: 540px) {
  .chat-main > header { gap: 8px; padding: 0 10px; }
  .chat-main > header span { display: none; }
  .fixture-run { padding: 5px 7px; font-size: 11px; }
  .transcript { width: calc(100% - 24px); padding-top: 20px; }
}
</style>
