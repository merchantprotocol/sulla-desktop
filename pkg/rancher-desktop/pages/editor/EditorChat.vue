<template>
  <div class="editor-chat" :class="{ dark: isDark }">
    <!-- Header -->
    <div class="chat-header" :class="{ dark: isDark }">
      <span class="chat-header-title">Chat</span>
      <button class="chat-close-btn" :class="{ dark: isDark }" title="Close Panel" @click="$emit('close')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </div>

    <!-- Messages -->
    <div ref="messagesEl" class="chat-messages" :class="{ dark: isDark }">
      <!-- Empty state -->
      <div v-if="messages.length === 0 && !loading" class="chat-empty">
        <p class="chat-empty-text">Ask anything about your code</p>
      </div>

      <div v-for="msg in messages" :key="msg.id" class="chat-message" :class="[msg.role]">
        <!-- User bubble -->
        <div v-if="msg.role === 'user'" class="bubble user-bubble" :class="{ dark: isDark }">
          <div class="bubble-content">{{ msg.content }}</div>
        </div>

        <!-- Tool card -->
        <div v-else-if="msg.kind === 'tool' && msg.toolCard" class="bubble tool-bubble" :class="{ dark: isDark }">
          <div class="tool-header">
            <span class="tool-name">{{ msg.toolCard.toolName }}</span>
            <span class="tool-status" :class="msg.toolCard.status">{{ msg.toolCard.status }}</span>
          </div>
        </div>

        <!-- Thinking -->
        <div v-else-if="msg.kind === 'thinking'" class="bubble thinking-bubble" :class="{ dark: isDark }">
          <div class="bubble-content thinking-text">{{ msg.content }}</div>
        </div>

        <!-- Assistant / system bubble -->
        <div v-else class="bubble assistant-bubble" :class="{ dark: isDark }">
          <div class="bubble-content prose-content" v-html="renderMarkdown(msg.content)"></div>
        </div>
      </div>

      <!-- Loading indicator -->
      <div v-if="loading" class="chat-message assistant">
        <div class="bubble assistant-bubble loading-bubble" :class="{ dark: isDark }">
          <span class="loading-dots">Thinking<span class="dot-anim">...</span></span>
        </div>
      </div>
    </div>

    <!-- Composer card -->
    <div class="chat-composer-wrapper">
      <div class="chat-composer-card" :class="{ dark: isDark }">
        <textarea
          ref="inputEl"
          :value="query"
          class="chat-input"
          :class="{ dark: isDark }"
          placeholder="Ask a question..."
          rows="1"
          @input="onInput"
          @keydown.enter.exact.prevent="onSend"
        ></textarea>
        <!-- Stop button when graph is running -->
        <button
          v-if="graphRunning"
          class="chat-stop-btn"
          :class="{ dark: isDark }"
          @click="$emit('stop')"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <rect x="3" y="3" width="10" height="10" rx="1"/>
          </svg>
        </button>
        <!-- Send button -->
        <button
          v-else
          class="chat-send-btn"
          :class="{ dark: isDark }"
          :disabled="!query.trim()"
          @click="onSend"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M1.724 1.053a.5.5 0 0 1 .54-.068l12 6a.5.5 0 0 1 0 .894l-12 6A.5.5 0 0 1 1.5 13.5v-4.9l7-1.1-7-1.1V1.5a.5.5 0 0 1 .224-.447Z"/>
          </svg>
        </button>
      </div>

      <!-- Agent selector + Model selector + token info -->
      <div class="chat-footer-bar" :class="{ dark: isDark }">
        <!-- Agent selector -->
        <div v-if="!hideAgentSelector" class="agent-selector-wrap">
          <button
            type="button"
            class="agent-trigger"
            :class="{ dark: isDark }"
            @click="toggleAgentMenu"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="8" r="4"/>
              <path d="M20 21a8 8 0 0 0-16 0"/>
            </svg>
            <span class="agent-label">{{ activeAgentName }}</span>
            <svg width="10" height="10" viewBox="0 0 15 15" fill="currentColor">
              <path d="M3.13523 6.15803C3.3241 5.95657 3.64052 5.94637 3.84197 6.13523L7.5 9.56464L11.158 6.13523C11.3595 5.94637 11.6759 5.95657 11.8648 6.15803C12.0536 6.35949 12.0434 6.67591 11.842 6.86477L7.84197 10.6148C7.64964 10.7951 7.35036 10.7951 7.15803 10.6148L3.15803 6.86477C2.95657 6.67591 2.94637 6.35949 3.13523 6.15803Z" fill-rule="evenodd" clip-rule="evenodd"/>
            </svg>
          </button>

          <div v-if="showAgentMenu" class="agent-menu" :class="{ dark: isDark }">
            <div class="agent-menu-header" :class="{ dark: isDark }">
              <span>Agents</span>
              <button type="button" class="agent-menu-close" :class="{ dark: isDark }" @click="showAgentMenu = false">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 8.707l3.646 3.647.708-.707L8.707 8l3.647-3.646-.707-.708L8 7.293 4.354 3.646l-.708.708L7.293 8l-3.647 3.646.708.707L8 8.707z"/>
                </svg>
              </button>
            </div>
            <button
              v-for="agent in visibleAgents"
              :key="agent.agentId"
              type="button"
              class="agent-option"
              :class="{ dark: isDark, active: agent.agentId === agentRegistry?.state.activeAgentId }"
              @click="selectAgent(agent.agentId)"
            >
              <span class="agent-option-label">{{ agent.agentName }}</span>
              <span class="agent-option-status" :class="agent.status">{{ agent.status }}</span>
            </button>
          </div>
        </div>

        <!-- Model selector -->
        <div class="model-selector-wrap" :ref="(el: any) => { if (modelSelector) modelSelector.modelMenuEl.value = el }">
          <button
            type="button"
            class="model-trigger"
            :class="{ dark: isDark }"
            :ref="(el: any) => { if (modelSelector) modelSelector.buttonRef.value = el }"
            @click="toggleModelMenu"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 8V4"/><path d="M8 4h8"/>
              <rect x="6" y="8" width="12" height="10" rx="2"/>
              <path d="M9 18v2"/><path d="M15 18v2"/>
              <path d="M9.5 12h.01"/><path d="M14.5 12h.01"/>
              <path d="M10 15h4"/>
            </svg>
            <span class="model-label">{{ modelSelector?.activeModelLabelValue || 'Select model' }}</span>
            <svg width="10" height="10" viewBox="0 0 15 15" fill="currentColor">
              <path d="M3.13523 6.15803C3.3241 5.95657 3.64052 5.94637 3.84197 6.13523L7.5 9.56464L11.158 6.13523C11.3595 5.94637 11.6759 5.95657 11.8648 6.15803C12.0536 6.35949 12.0434 6.67591 11.842 6.86477L7.84197 10.6148C7.64964 10.7951 7.35036 10.7951 7.15803 10.6148L3.15803 6.86477C2.95657 6.67591 2.94637 6.35949 3.13523 6.15803Z" fill-rule="evenodd" clip-rule="evenodd"/>
            </svg>
          </button>

          <!-- Dropdown menu -->
          <div v-if="modelSelector?.showModelMenuValue" class="model-menu" :class="{ dark: isDark }">
            <div class="model-menu-header" :class="{ dark: isDark }">
              <span>Models</span>
              <button type="button" class="model-menu-close" :class="{ dark: isDark }" @click="modelSelector?.hideModelMenu()">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 8.707l3.646 3.647.708-.707L8.707 8l3.647-3.646-.707-.708L8 7.293 4.354 3.646l-.708.708L7.293 8l-3.647 3.646.708.707L8 8.707z"/>
                </svg>
              </button>
            </div>

            <div v-if="modelSelector?.loadingProvidersValue" class="model-menu-loading">Loading providers...</div>

            <template v-for="(group, gIdx) in (modelSelector?.providerGroupsValue || [])" :key="group.providerId">
              <div v-if="gIdx > 0" class="model-menu-divider" :class="{ dark: isDark }"></div>
              <div class="model-group-header" :class="{ dark: isDark }">
                {{ group.providerName }}
                <span v-if="group.isActiveProvider" class="model-primary-badge">Primary</span>
              </div>
              <div v-if="group.loading" class="model-menu-loading">Loading models...</div>
              <button
                v-for="m in group.models"
                :key="`${group.providerId}-${m.modelId}`"
                type="button"
                class="model-option"
                :class="{ dark: isDark, active: m.isActiveModel }"
                @click="modelSelector?.selectModel(m)"
              >
                <span class="model-option-label">{{ m.modelLabel }}</span>
                <span v-if="m.isActiveModel" class="model-option-active">Active</span>
              </button>
            </template>
          </div>
        </div>

        <!-- Token info -->
        <span class="token-info" :class="{ dark: isDark }">{{ tokenLabel }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick, computed } from 'vue';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { ChatMessage } from '@pkg/agent';
import type { AgentModelSelectorController } from '@pkg/pages/agent/AgentModelSelectorController';
import type { AgentPersonaRegistry } from '@pkg/agent/database/registry/AgentPersonaRegistry';

const props = defineProps<{
  isDark: boolean;
  messages: ChatMessage[];
  query: string;
  loading: boolean;
  graphRunning: boolean;
  modelSelector?: AgentModelSelectorController;
  agentRegistry?: AgentPersonaRegistry;
  totalTokensUsed?: number;
  hideAgentSelector?: boolean;
}>();

const showAgentMenu = ref(false);

const activeAgentName = computed(() => props.agentRegistry?.activeAgent.value?.agentName || 'Agent');
const visibleAgents = computed(() => props.agentRegistry?.visibleAgents.value || []);

function toggleAgentMenu() {
  showAgentMenu.value = !showAgentMenu.value;
}

function selectAgent(agentId: string) {
  props.agentRegistry?.setActiveAgent(agentId);
  showAgentMenu.value = false;
}

const emit = defineEmits<{
  'update:query': [value: string];
  'send': [];
  'stop': [];
  'close': [];
}>();

const tokenLabel = computed(() => {
  const t = props.totalTokensUsed || 0;
  if (t === 0) return '';
  if (t >= 1000) return `${(t / 1000).toFixed(1)}k tokens`;
  return `${t} tokens`;
});

function toggleModelMenu() {
  props.modelSelector?.toggleModelMenu();
}

const messagesEl = ref<HTMLElement>();
const inputEl = ref<HTMLTextAreaElement>();

function renderMarkdown(content: string): string {
  const raw = typeof content === 'string' ? content : String(content || '');
  const html = (marked(raw) as string) || '';
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

function scrollToBottom() {
  nextTick(() => {
    if (messagesEl.value) {
      messagesEl.value.scrollTop = messagesEl.value.scrollHeight;
    }
  });
}

function autoGrow() {
  const el = inputEl.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function onInput(e: Event) {
  const target = e.target as HTMLTextAreaElement;
  emit('update:query', target.value);
  autoGrow();
}

function onSend() {
  if (!props.query.trim()) return;
  emit('send');
  nextTick(() => {
    if (inputEl.value) {
      inputEl.value.style.height = 'auto';
    }
  });
}

// Auto-scroll on new messages
watch(() => props.messages.length, () => scrollToBottom());
</script>

<style scoped>
.editor-chat {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px 0 12px;
  height: 35px;
  background: #f8fafc;
  border-bottom: 1px solid #cbd5e1;
  flex-shrink: 0;
}

.chat-header.dark {
  background: #1e293b;
  border-bottom-color: #334155;
}

.chat-header-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #64748b;
}

.chat-header.dark .chat-header-title {
  color: #94a3b8;
}

.chat-close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: #94a3b8;
  border-radius: 4px;
  cursor: pointer;
}

.chat-close-btn:hover {
  background: rgba(0,0,0,0.06);
  color: #475569;
}

.chat-close-btn.dark {
  color: #64748b;
}

.chat-close-btn.dark:hover {
  background: rgba(255,255,255,0.08);
  color: #94a3b8;
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: 10px;
}

.chat-messages.dark::-webkit-scrollbar {
  width: 6px;
}

.chat-messages.dark::-webkit-scrollbar-thumb {
  background: #475569;
  border-radius: 3px;
}

.chat-messages::-webkit-scrollbar {
  width: 6px;
}

.chat-messages::-webkit-scrollbar-thumb {
  background: #cbd5e1;
  border-radius: 3px;
}

.chat-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.chat-empty-text {
  font-size: 13px;
  color: #94a3b8;
}

.dark .chat-empty-text {
  color: #64748b;
}

.chat-message.user {
  display: flex;
  justify-content: flex-end;
}

.chat-message.assistant,
.chat-message.system,
.chat-message.error {
  display: flex;
  justify-content: flex-start;
}

.bubble {
  max-width: 92%;
  padding: 8px 12px;
  border-radius: 12px;
  font-size: 13px;
  line-height: 1.5;
  word-break: break-word;
}

.user-bubble {
  background: #e0f2fe;
  color: #0c4a6e;
}

.user-bubble.dark {
  background: rgba(56, 189, 248, 0.15);
  color: #e0f2fe;
}

.assistant-bubble {
  background: #f1f5f9;
  color: #334155;
}

.assistant-bubble.dark {
  background: rgba(255, 255, 255, 0.06);
  color: #e2e8f0;
}

.tool-bubble {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  color: #475569;
  font-size: 12px;
}

.tool-bubble.dark {
  background: #1e293b;
  border-color: #334155;
  color: #94a3b8;
}

.tool-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tool-name {
  font-family: monospace;
  font-size: 11px;
}

.tool-status {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  font-weight: 500;
}

.tool-status.running { background: #fef3c7; color: #92400e; }
.tool-status.success { background: #d1fae5; color: #065f46; }
.tool-status.failed  { background: #fee2e2; color: #991b1b; }

.dark .tool-status.running { background: rgba(245, 158, 11, 0.15); color: #fbbf24; }
.dark .tool-status.success { background: rgba(16, 185, 129, 0.15); color: #34d399; }
.dark .tool-status.failed  { background: rgba(239, 68, 68, 0.15); color: #f87171; }

.thinking-bubble {
  background: transparent;
  color: #94a3b8;
}

.thinking-bubble.dark {
  color: #64748b;
}

.thinking-text {
  font-style: italic;
  font-size: 12px;
}

.bubble-content {
  white-space: pre-wrap;
}

.prose-content {
  white-space: normal;
}

.prose-content :deep(p) {
  margin: 0 0 0.5em;
}

.prose-content :deep(p:last-child) {
  margin-bottom: 0;
}

.prose-content :deep(pre) {
  background: #1e293b;
  color: #e2e8f0;
  padding: 8px;
  border-radius: 6px;
  overflow-x: auto;
  font-size: 12px;
  margin: 4px 0;
}

.dark .prose-content :deep(pre) {
  background: #0f172a;
}

.prose-content :deep(code) {
  font-size: 12px;
  font-family: 'Menlo', 'Monaco', 'Courier New', monospace;
}

.prose-content :deep(code:not(pre code)) {
  background: rgba(0, 0, 0, 0.06);
  padding: 1px 4px;
  border-radius: 3px;
}

.dark .prose-content :deep(code:not(pre code)) {
  background: rgba(255, 255, 255, 0.1);
}

.loading-bubble {
  padding: 6px 12px;
}

.loading-dots {
  font-size: 12px;
  color: #94a3b8;
}

@keyframes dotPulse {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 1; }
}

.dot-anim {
  animation: dotPulse 1.2s ease-in-out infinite;
}

.chat-composer-wrapper {
  flex-shrink: 0;
  padding: 8px 10px 10px;
}

.chat-composer-card {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  padding: 8px;
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08), 0 1px 3px rgba(0, 0, 0, 0.04);
}

.chat-composer-card.dark {
  background: #1e293b;
  border-color: #334155;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3), 0 1px 3px rgba(0, 0, 0, 0.2);
}

.chat-input {
  flex: 1;
  resize: none;
  border: none;
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 13px;
  font-family: inherit;
  line-height: 1.4;
  background: transparent;
  color: #333;
  outline: none;
  min-height: 28px;
  max-height: 120px;
  overflow-y: auto;
}

.chat-input::placeholder {
  color: #94a3b8;
}

.chat-input.dark {
  color: #e2e8f0;
}

.chat-input.dark::placeholder {
  color: #64748b;
}

.chat-send-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: none;
  border-radius: 8px;
  background: #0078d4;
  color: #fff;
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.1s;
}

.chat-send-btn:hover:not(:disabled) {
  background: #106ebe;
}

.chat-send-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.chat-send-btn.dark {
  background: #2563eb;
}

.chat-send-btn.dark:hover:not(:disabled) {
  background: #3b82f6;
}

.chat-stop-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: none;
  border-radius: 8px;
  background: #dc2626;
  color: #fff;
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.1s;
}

.chat-stop-btn:hover {
  background: #b91c1c;
}

.chat-stop-btn.dark {
  background: #ef4444;
}

.chat-stop-btn.dark:hover {
  background: #dc2626;
}

/* Footer bar: model selector + token info */
.chat-footer-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 10px 6px;
  flex-shrink: 0;
}

/* Agent selector */
.agent-selector-wrap {
  position: relative;
}

.agent-trigger {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: #64748b;
  font-size: 11px;
  cursor: pointer;
  transition: background 0.1s;
}

.agent-trigger:hover {
  background: rgba(0, 0, 0, 0.05);
}

.agent-trigger.dark {
  color: #94a3b8;
}

.agent-trigger.dark:hover {
  background: rgba(255, 255, 255, 0.06);
}

.agent-label {
  white-space: nowrap;
  font-weight: 500;
  max-width: 100px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.agent-menu {
  position: absolute;
  bottom: 28px;
  left: 0;
  z-index: 9999;
  width: 200px;
  max-height: 240px;
  overflow-y: auto;
  border-radius: 10px;
  border: 1px solid rgba(0, 0, 0, 0.1);
  background: #fff;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
}

.agent-menu.dark {
  border-color: rgba(255, 255, 255, 0.1);
  background: #1e293b;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
}

.agent-menu-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #94a3b8;
  position: sticky;
  top: 0;
  background: #fff;
  z-index: 1;
}

.agent-menu-header.dark {
  background: #1e293b;
  color: #64748b;
}

.agent-menu-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: #94a3b8;
  cursor: pointer;
}

.agent-menu-close:hover {
  background: rgba(0, 0, 0, 0.06);
}

.agent-menu-close.dark:hover {
  background: rgba(255, 255, 255, 0.08);
}

.agent-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 5px 10px;
  border: none;
  background: transparent;
  font-size: 12px;
  color: #334155;
  cursor: pointer;
  text-align: left;
}

.agent-option:hover {
  background: rgba(0, 0, 0, 0.04);
}

.agent-option.dark {
  color: #e2e8f0;
}

.agent-option.dark:hover {
  background: rgba(255, 255, 255, 0.06);
}

.agent-option.active {
  font-weight: 600;
}

.agent-option-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-option-status {
  font-size: 9px;
  font-weight: 500;
  padding: 1px 5px;
  border-radius: 8px;
  text-transform: capitalize;
  flex-shrink: 0;
}

.agent-option-status.online { background: #d1fae5; color: #065f46; }
.agent-option-status.idle { background: #fef3c7; color: #92400e; }
.agent-option-status.busy { background: #e0f2fe; color: #0369a1; }
.agent-option-status.offline { background: #f1f5f9; color: #64748b; }

.dark .agent-option-status.online { background: rgba(16, 185, 129, 0.15); color: #34d399; }
.dark .agent-option-status.idle { background: rgba(245, 158, 11, 0.15); color: #fbbf24; }
.dark .agent-option-status.busy { background: rgba(14, 165, 233, 0.15); color: #38bdf8; }
.dark .agent-option-status.offline { background: rgba(100, 116, 139, 0.15); color: #94a3b8; }

/* Model selector */
.model-selector-wrap {
  position: relative;
}

.model-trigger {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: #64748b;
  font-size: 11px;
  cursor: pointer;
  transition: background 0.1s;
}

.model-trigger:hover {
  background: rgba(0, 0, 0, 0.05);
}

.model-trigger.dark {
  color: #94a3b8;
}

.model-trigger.dark:hover {
  background: rgba(255, 255, 255, 0.06);
}

.model-label {
  white-space: nowrap;
  font-weight: 500;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Model dropdown menu */
.model-menu {
  position: absolute;
  bottom: 28px;
  left: 0;
  z-index: 9999;
  width: 240px;
  max-height: 280px;
  overflow-y: auto;
  border-radius: 10px;
  border: 1px solid rgba(0, 0, 0, 0.1);
  background: #fff;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
}

.model-menu.dark {
  border-color: rgba(255, 255, 255, 0.1);
  background: #1e293b;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
}

.model-menu::-webkit-scrollbar { width: 6px; }
.model-menu::-webkit-scrollbar-thumb {
  background: rgba(0, 0, 0, 0.15);
  border-radius: 3px;
}
.model-menu.dark::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.15);
}

.model-menu-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #94a3b8;
  position: sticky;
  top: 0;
  background: #fff;
  z-index: 1;
}

.model-menu-header.dark {
  background: #1e293b;
  color: #64748b;
}

.model-menu-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: #94a3b8;
  cursor: pointer;
}

.model-menu-close:hover {
  background: rgba(0, 0, 0, 0.06);
}

.model-menu-close.dark:hover {
  background: rgba(255, 255, 255, 0.08);
}

.model-menu-loading {
  padding: 4px 10px;
  font-size: 11px;
  color: #94a3b8;
}

.model-menu-divider {
  height: 1px;
  background: rgba(0, 0, 0, 0.08);
  margin: 2px 0;
}

.model-menu-divider.dark {
  background: rgba(255, 255, 255, 0.08);
}

.model-group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #94a3b8;
}

.model-group-header.dark {
  color: #64748b;
}

.model-primary-badge {
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 8px;
  background: #e0f2fe;
  color: #0369a1;
  font-weight: 600;
  text-transform: none;
  letter-spacing: 0;
}

.dark .model-primary-badge {
  background: rgba(14, 165, 233, 0.15);
  color: #38bdf8;
}

.model-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 5px 10px;
  border: none;
  background: transparent;
  font-size: 12px;
  color: #334155;
  cursor: pointer;
  text-align: left;
}

.model-option:hover {
  background: rgba(0, 0, 0, 0.04);
}

.model-option.dark {
  color: #e2e8f0;
}

.model-option.dark:hover {
  background: rgba(255, 255, 255, 0.06);
}

.model-option-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-option-active {
  font-size: 10px;
  font-weight: 500;
  color: #94a3b8;
  flex-shrink: 0;
}

.token-info {
  font-size: 10px;
  color: #94a3b8;
  white-space: nowrap;
}

.token-info.dark {
  color: #64748b;
}
</style>
