<template>
  <div
    class="editor-chat"
    :class="{ dark: isDark }"
  >
    <!-- Header -->
    <div
      class="chat-header"
      :class="{ dark: isDark }"
    >
      <span class="chat-header-title">Chat</span>
      <button
        class="chat-close-btn"
        :class="{ dark: isDark }"
        title="Close Panel"
        @click="$emit('close')"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <line
            x1="18"
            y1="6"
            x2="6"
            y2="18"
          />
          <line
            x1="6"
            y1="6"
            x2="18"
            y2="18"
          />
        </svg>
      </button>
    </div>

    <!-- Messages -->
    <div
      ref="messagesEl"
      class="chat-messages"
      :class="{ dark: isDark }"
    >
      <!-- Empty state -->
      <div
        v-if="messages.length === 0 && !loading"
        class="chat-empty"
      >
        <p class="chat-empty-text">
          Ask anything about your code
        </p>
      </div>

      <!-- Spacer pushes messages to bottom when few messages -->
      <div
        v-if="messages.length > 0"
        class="chat-messages-spacer"
      />

      <div
        v-for="msg in messages"
        :key="msg.id"
        class="chat-message"
        :class="[msg.role]"
      >
        <!-- User bubble -->
        <div
          v-if="msg.role === 'user'"
          class="bubble user-bubble"
          :class="{ dark: isDark }"
        >
          <div class="bubble-content">
            {{ msg.content }}
          </div>
        </div>

        <!-- Tool card (expandable, Claude Code style) -->
        <div
          v-else-if="msg.kind === 'tool' && msg.toolCard"
          class="tool-card-cc"
          :class="{ dark: isDark, expanded: expandedToolCards.has(msg.id) }"
        >
          <button
            class="tool-card-cc-header"
            @click="toggleToolCard(msg.id)"
          >
            <span
              class="tool-card-cc-dot"
              :class="msg.toolCard.status"
            />
            <span class="tool-card-cc-name">{{ toolCardLabel(msg.toolCard) }}</span>
            <span
              v-if="msg.toolCard.description"
              class="tool-card-cc-desc"
            >{{ msg.toolCard.description }}</span>
            <svg
              width="12"
              height="12"
              viewBox="0 0 15 15"
              fill="none"
              class="tool-card-cc-chevron"
              :class="{ open: expandedToolCards.has(msg.id) }"
            >
              <path
                d="M3.13523 6.15803C3.3241 5.95657 3.64052 5.94637 3.84197 6.13523L7.5 9.56464L11.158 6.13523C11.3595 5.94637 11.6759 5.95657 11.8648 6.15803C12.0536 6.35949 12.0434 6.67591 11.842 6.86477L7.84197 10.6148C7.64964 10.7951 7.35036 10.7951 7.15803 10.6148L3.15803 6.86477C2.95657 6.67591 2.94637 6.35949 3.13523 6.15803Z"
                fill="currentColor"
                fill-rule="evenodd"
                clip-rule="evenodd"
              />
            </svg>
          </button>
          <div
            v-if="toolCardCommand(msg.toolCard)"
            class="tool-card-cc-cmd"
          >
            <span class="tool-card-cc-cmd-label">IN</span>
            <code class="tool-card-cc-cmd-text">{{ toolCardCommand(msg.toolCard) }}</code>
          </div>
          <div
            v-if="msg.toolCard.status !== 'running' && toolCardCommand(msg.toolCard)"
            class="tool-card-cc-cmd"
          >
            <span class="tool-card-cc-cmd-label">OUT</span>
            <code
              class="tool-card-cc-cmd-text tool-card-cc-exit"
              :class="msg.toolCard.status"
            >{{ msg.toolCard.status === 'success' ? '0' : '1' }}</code>
          </div>
          <div
            v-show="expandedToolCards.has(msg.id)"
            class="tool-card-cc-body"
          >
            <div
              v-if="toolCardOutput(msg.toolCard)"
              class="tool-card-cc-output"
            >
              <pre>{{ toolCardOutput(msg.toolCard) }}</pre>
            </div>
            <div
              v-if="!toolCardCommand(msg.toolCard) && msg.toolCard.args && Object.keys(msg.toolCard.args).length > 0"
              class="tool-card-cc-output"
            >
              <div class="tool-card-cc-section-label">
                Arguments
              </div>
              <pre>{{ JSON.stringify(msg.toolCard.args, null, 2) }}</pre>
            </div>
            <div
              v-if="!toolCardCommand(msg.toolCard) && msg.toolCard.result !== undefined"
              class="tool-card-cc-output"
            >
              <div class="tool-card-cc-section-label">
                Result
              </div>
              <pre>{{ typeof msg.toolCard.result === 'string' ? msg.toolCard.result : JSON.stringify(msg.toolCard.result, null, 2) }}</pre>
            </div>
            <div
              v-if="msg.toolCard.error"
              class="tool-card-cc-error"
            >
              {{ msg.toolCard.error }}
            </div>
          </div>
        </div>

        <!-- Workflow node card -->
        <WorkflowNodeCard
          v-else-if="msg.kind === 'workflow_node' && msg.workflowNode"
          :node="msg.workflowNode"
          :is-dark="isDark"
        />

        <!-- Thinking -->
        <div
          v-else-if="msg.kind === 'thinking'"
          class="bubble thinking-bubble"
          :class="{ dark: isDark }"
        >
          <div class="bubble-content thinking-text">
            {{ msg.content }}
          </div>
        </div>

        <!-- Assistant / system bubble -->
        <div
          v-else
          class="bubble assistant-bubble"
          :class="{ dark: isDark }"
        >
          <div
            class="bubble-content prose-content"
            v-html="renderMarkdown(msg.content)"
          />
        </div>
      </div>

      <!-- Activity status indicator -->
      <div
        v-if="loading || graphRunning"
        class="chat-activity-status"
      >
        <span class="activity-dot" />
        <span class="activity-text">{{ currentActivity || 'Thinking' }}..<span class="blink-dot">.</span></span>
      </div>

      <!-- Waiting for user indicator -->
      <div
        v-if="waitingForUser && !loading && !graphRunning"
        class="waiting-for-user"
        :class="{ dark: isDark }"
      >
        <span class="waiting-dot" />
        <span class="waiting-text">Waiting for your response</span>
      </div>
    </div>

    <!-- Composer card -->
    <div class="chat-composer-wrapper">
      <div
        class="chat-composer-card"
        :class="{ dark: isDark }"
      >
        <textarea
          ref="inputEl"
          :value="query"
          class="chat-input"
          :class="{ dark: isDark }"
          placeholder="Ask a question..."
          rows="1"
          @input="onInput"
          @keydown.enter.exact.prevent="onSend"
        />
        <!-- Stop button when graph is running -->
        <button
          v-if="graphRunning"
          class="chat-stop-btn"
          :class="{ dark: isDark }"
          @click="$emit('stop')"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="currentColor"
          >
            <rect
              x="3"
              y="3"
              width="10"
              height="10"
              rx="1"
            />
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
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="currentColor"
          >
            <path d="M1.724 1.053a.5.5 0 0 1 .54-.068l12 6a.5.5 0 0 1 0 .894l-12 6A.5.5 0 0 1 1.5 13.5v-4.9l7-1.1-7-1.1V1.5a.5.5 0 0 1 .224-.447Z" />
          </svg>
        </button>
      </div>

      <!-- Agent selector + Model selector + token info -->
      <div
        class="chat-footer-bar"
        :class="{ dark: isDark }"
      >
        <!-- Agent selector -->
        <div
          v-if="!hideAgentSelector"
          class="agent-selector-wrap"
        >
          <button
            type="button"
            class="agent-trigger"
            :class="{ dark: isDark }"
            @click="toggleAgentMenu"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <circle
                cx="12"
                cy="8"
                r="4"
              />
              <path d="M20 21a8 8 0 0 0-16 0" />
            </svg>
            <span class="agent-label">{{ activeAgentName }}</span>
            <svg
              width="10"
              height="10"
              viewBox="0 0 15 15"
              fill="currentColor"
            >
              <path
                d="M3.13523 6.15803C3.3241 5.95657 3.64052 5.94637 3.84197 6.13523L7.5 9.56464L11.158 6.13523C11.3595 5.94637 11.6759 5.95657 11.8648 6.15803C12.0536 6.35949 12.0434 6.67591 11.842 6.86477L7.84197 10.6148C7.64964 10.7951 7.35036 10.7951 7.15803 10.6148L3.15803 6.86477C2.95657 6.67591 2.94637 6.35949 3.13523 6.15803Z"
                fill-rule="evenodd"
                clip-rule="evenodd"
              />
            </svg>
          </button>

          <div
            v-if="showAgentMenu"
            class="agent-menu"
            :class="{ dark: isDark }"
          >
            <div
              class="agent-menu-header"
              :class="{ dark: isDark }"
            >
              <span>Agents</span>
              <button
                type="button"
                class="agent-menu-close"
                :class="{ dark: isDark }"
                @click="showAgentMenu = false"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                >
                  <path d="M8 8.707l3.646 3.647.708-.707L8.707 8l3.647-3.646-.707-.708L8 7.293 4.354 3.646l-.708.708L7.293 8l-3.647 3.646.708.707L8 8.707z" />
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
              <span
                class="agent-option-status"
                :class="agent.status"
              >{{ agent.status }}</span>
            </button>
          </div>
        </div>

        <!-- Model selector -->
        <div
          :ref="(el: any) => { if (modelSelector) modelSelector.modelMenuEl.value = el }"
          class="model-selector-wrap"
        >
          <button
            :ref="(el: any) => { if (modelSelector) modelSelector.buttonRef.value = el }"
            type="button"
            class="model-trigger"
            :class="{ dark: isDark }"
            @click="toggleModelMenu"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M12 8V4" /><path d="M8 4h8" />
              <rect
                x="6"
                y="8"
                width="12"
                height="10"
                rx="2"
              />
              <path d="M9 18v2" /><path d="M15 18v2" />
              <path d="M9.5 12h.01" /><path d="M14.5 12h.01" />
              <path d="M10 15h4" />
            </svg>
            <span class="model-label">{{ modelSelector?.activeModelLabelValue || 'Select model' }}</span>
            <svg
              width="10"
              height="10"
              viewBox="0 0 15 15"
              fill="currentColor"
            >
              <path
                d="M3.13523 6.15803C3.3241 5.95657 3.64052 5.94637 3.84197 6.13523L7.5 9.56464L11.158 6.13523C11.3595 5.94637 11.6759 5.95657 11.8648 6.15803C12.0536 6.35949 12.0434 6.67591 11.842 6.86477L7.84197 10.6148C7.64964 10.7951 7.35036 10.7951 7.15803 10.6148L3.15803 6.86477C2.95657 6.67591 2.94637 6.35949 3.13523 6.15803Z"
                fill-rule="evenodd"
                clip-rule="evenodd"
              />
            </svg>
          </button>

          <!-- Dropdown menu -->
          <div
            v-if="modelSelector?.showModelMenuValue"
            class="model-menu"
            :class="{ dark: isDark }"
          >
            <div
              class="model-menu-header"
              :class="{ dark: isDark }"
            >
              <span>Models</span>
              <button
                type="button"
                class="model-menu-close"
                :class="{ dark: isDark }"
                @click="modelSelector?.hideModelMenu()"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                >
                  <path d="M8 8.707l3.646 3.647.708-.707L8.707 8l3.647-3.646-.707-.708L8 7.293 4.354 3.646l-.708.708L7.293 8l-3.647 3.646.708.707L8 8.707z" />
                </svg>
              </button>
            </div>

            <div
              v-if="modelSelector?.loadingProvidersValue"
              class="model-menu-loading"
            >
              Loading providers...
            </div>

            <template
              v-for="(group, gIdx) in (modelSelector?.providerGroupsValue || [])"
              :key="group.providerId"
            >
              <div
                v-if="gIdx > 0"
                class="model-menu-divider"
                :class="{ dark: isDark }"
              />
              <div
                class="model-group-header"
                :class="{ dark: isDark }"
              >
                {{ group.providerName }}
                <span
                  v-if="group.isActiveProvider"
                  class="model-primary-badge"
                >Primary</span>
              </div>
              <div
                v-if="group.loading"
                class="model-menu-loading"
              >
                Loading models...
              </div>
              <button
                v-for="m in group.models"
                :key="`${group.providerId}-${m.modelId}`"
                type="button"
                class="model-option"
                :class="{ dark: isDark, active: m.isActiveModel }"
                @click="modelSelector?.selectModel(m)"
              >
                <span class="model-option-label">{{ m.modelLabel }}</span>
                <span
                  v-if="m.isActiveModel"
                  class="model-option-active"
                >Active</span>
              </button>
            </template>
          </div>
        </div>

        <!-- Token info -->
        <span
          class="token-info"
          :class="{ dark: isDark }"
        >{{ tokenLabel }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, watch, nextTick, computed } from 'vue';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { ChatMessage } from '@pkg/agent';
import type { AgentModelSelectorController } from '@pkg/pages/agent/AgentModelSelectorController';
import type { AgentPersonaRegistry } from '@pkg/agent/database/registry/AgentPersonaRegistry';
import WorkflowNodeCard from './workflow/WorkflowNodeCard.vue';

const props = defineProps<{
  isDark:             boolean;
  messages:           ChatMessage[];
  query:              string;
  loading:            boolean;
  graphRunning:       boolean;
  waitingForUser?:    boolean;
  currentActivity?:   string;
  modelSelector?:     AgentModelSelectorController;
  agentRegistry?:     AgentPersonaRegistry;
  totalTokensUsed?:   number;
  hideAgentSelector?: boolean;
}>();

const showAgentMenu = ref(false);
const expandedToolCards = reactive(new Set<string>());

function toggleToolCard(messageId: string) {
  if (expandedToolCards.has(messageId)) {
    expandedToolCards.delete(messageId);
  } else {
    expandedToolCards.add(messageId);
  }
}

const EXEC_TOOL_NAMES = new Set(['exec', 'exec_command', 'shell', 'bash', 'run_command']);

function toolCardLabel(toolCard: { toolName: string }): string {
  return EXEC_TOOL_NAMES.has(toolCard.toolName) ? 'Bash' : toolCard.toolName;
}

function toolCardCommand(toolCard: { toolName: string; args?: Record<string, unknown> }): string | null {
  if (!EXEC_TOOL_NAMES.has(toolCard.toolName)) return null;
  const cmd = toolCard.args?.command ?? toolCard.args?.cmd;
  return typeof cmd === 'string' ? cmd : null;
}

function toolCardOutput(toolCard: { toolName: string; result?: unknown }): string | null {
  if (!toolCard.result) return null;
  const r = toolCard.result as any;
  if (typeof r.responseString === 'string' && r.responseString.trim()) return r.responseString;
  if (typeof r.result === 'string' && r.result.trim()) return r.result;
  if (typeof r === 'string' && r.trim()) return r;
  return null;
}

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
  send:           [];
  stop:           [];
  close:          [];
}>();

const tokenLabel = computed(() => {
  const t = props.totalTokensUsed || 0;
  if (t === 0) return '';
  if (t >= 1000) return `${ (t / 1000).toFixed(1) }k tokens`;
  return `${ t } tokens`;
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
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-default);
  flex-shrink: 0;
}

.chat-header-title {
  font-size: var(--fs-body-sm);
  font-weight: var(--weight-semibold);
  text-transform: uppercase;
  letter-spacing: var(--tracking-wider);
  color: var(--text-secondary);
}

.chat-close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  border-radius: 4px;
  cursor: pointer;
}

.chat-close-btn:hover {
  background: var(--bg-hover);
  color: var(--text-secondary);
}

.chat-messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.chat-messages-spacer {
  flex: 1;
}

.chat-messages.dark::-webkit-scrollbar {
  width: 6px;
}

.chat-messages::-webkit-scrollbar-thumb {
  background: var(--bg-surface-hover);
  border-radius: 3px;
}

.chat-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.chat-empty-text {
  font-size: var(--fs-code);
  color: var(--text-muted);
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
  font-size: var(--fs-code);
  line-height: 1.5;
  word-break: break-word;
}

.user-bubble {
  background: var(--bg-info);
  color: var(--text-info);
}

.assistant-bubble {
  background: var(--bg-surface-alt);
  color: var(--text-secondary);
}

/* ── Claude Code-style tool card ── */
.tool-card-cc {
  border: 1px solid var(--border-default);
  border-radius: 8px;
  background: var(--bg-surface);
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: var(--fs-code);
}

.tool-card-cc-header {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 10px;
  background: none;
  border: none;
  cursor: pointer;
  font: inherit;
  color: var(--text-primary);
  text-align: left;
}

.tool-card-cc-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.tool-card-cc-dot.running { background: var(--status-warning); animation: ccDotPulse 1.5s ease-in-out infinite; }
.tool-card-cc-dot.success { background: var(--status-success); }
.tool-card-cc-dot.failed  { background: var(--status-error); }

@keyframes ccDotPulse {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 1; }
}

.tool-card-cc-name {
  font-weight: var(--weight-bold);
  font-size: var(--fs-code);
  color: var(--text-primary);
}

.tool-card-cc-desc {
  font-weight: var(--weight-normal);
  font-size: var(--fs-code);
  color: var(--text-secondary);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-card-cc-chevron {
  color: var(--text-muted);
  transition: transform 0.15s ease;
  flex-shrink: 0;
  margin-left: auto;
}
.tool-card-cc-chevron.open {
  transform: rotate(180deg);
}

.tool-card-cc-cmd {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 2px 10px 2px 16px;
  font-size: var(--fs-body-sm);
}

.tool-card-cc-cmd-label {
  font-size: var(--fs-caption);
  font-weight: var(--weight-bold);
  color: var(--text-muted);
  text-transform: uppercase;
  flex-shrink: 0;
  min-width: 20px;
}

.tool-card-cc-cmd-text {
  color: var(--text-secondary);
  word-break: break-all;
  white-space: pre-wrap;
}

.tool-card-cc-exit.success { color: var(--text-success); }
.tool-card-cc-exit.failed  { color: var(--text-error); }

.tool-card-cc-body {
  border-top: 1px solid var(--border-default);
  margin: 4px 0 0;
}

.tool-card-cc-output {
  padding: 6px 10px;
}
.tool-card-cc-output pre {
  margin: 0;
  padding: 0;
  background: none;
  color: var(--text-secondary);
  font-size: var(--fs-body-sm);
  font-family: var(--font-mono);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 200px;
  overflow-y: auto;
}

.tool-card-cc-section-label {
  font-size: var(--fs-caption);
  font-weight: var(--weight-bold);
  color: var(--text-muted);
  text-transform: uppercase;
  margin-bottom: 3px;
}

.tool-card-cc-error {
  padding: 6px 10px;
  font-size: var(--fs-body-sm);
  color: var(--text-error);
}

.thinking-bubble {
  background: transparent;
  color: var(--text-muted);
}

.thinking-text {
  font-style: italic;
  font-size: var(--fs-code);
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
  background: var(--bg-surface, #1e293b);
  color: var(--text-muted);
  padding: 8px;
  border-radius: 6px;
  overflow-x: auto;
  font-size: var(--fs-code);
  margin: 4px 0;
}

.dark .prose-content :deep(pre) {
  background: var(--editor-bg, #0f172a);
}

.prose-content :deep(code) {
  font-size: var(--fs-code);
  font-family: var(--font-mono);
}

.prose-content :deep(code:not(pre code)) {
  background: var(--bg-hover);
  padding: 1px 4px;
  border-radius: 3px;
}

.chat-activity-status {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px;
}

.activity-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent-primary);
  animation: activityPulse 1.5s ease-in-out infinite;
  flex-shrink: 0;
}

.activity-text {
  font-size: var(--fs-body-sm);
  font-weight: var(--weight-bold, 700);
  color: var(--text-secondary);
}

.blink-dot {
  animation: blinkDot 1s step-end infinite;
}

@keyframes blinkDot {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}

@keyframes activityPulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}

.waiting-for-user {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
}

.waiting-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--status-warning);
  animation: waitingPulse 2s ease-in-out infinite;
  flex-shrink: 0;
}

.waiting-text {
  font-size: var(--fs-body-sm);
  color: var(--text-muted);
  font-style: italic;
}

@keyframes waitingPulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
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
  background: var(--bg-input);
  border: 1px solid var(--border-default);
  border-radius: 12px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08), 0 1px 3px rgba(0, 0, 0, 0.04);
}

.chat-input {
  flex: 1;
  resize: none;
  border: none;
  border-radius: 6px;
  padding: 6px 8px;
  font-size: var(--fs-code);
  font-family: inherit;
  line-height: 1.4;
  background: transparent;
  color: var(--text-primary);
  outline: none;
  min-height: 28px;
  max-height: 120px;
  overflow-y: auto;
}

.chat-input::placeholder {
  color: var(--text-muted);
}

.chat-send-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: none;
  border-radius: 8px;
  background: var(--accent-primary, #0078d4);
  color: var(--text-on-accent);
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.1s;
}

.chat-send-btn:hover:not(:disabled) {
  background: var(--accent-primary-hover, #106ebe);
}

.chat-send-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.chat-stop-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: none;
  border-radius: 8px;
  background: var(--status-error);
  color: var(--text-on-accent);
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.1s;
}

.chat-stop-btn:hover {
  background: var(--status-error-hover, #b91c1c);
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
  color: var(--text-secondary);
  font-size: var(--fs-body-sm);
  cursor: pointer;
  transition: background 0.1s;
}

.agent-trigger:hover {
  background: var(--bg-hover);
}

.agent-label {
  white-space: nowrap;
  font-weight: var(--weight-medium);
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
  border: 1px solid var(--border-default);
  background: var(--bg-surface);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
}

.agent-menu-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  font-size: var(--fs-caption);
  font-weight: var(--weight-semibold);
  text-transform: uppercase;
  letter-spacing: var(--tracking-wide);
  color: var(--text-muted);
  position: sticky;
  top: 0;
  background: var(--bg-surface);
  z-index: 1;
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
  color: var(--text-muted);
  cursor: pointer;
}

.agent-menu-close:hover {
  background: var(--bg-hover);
}

.agent-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 5px 10px;
  border: none;
  background: transparent;
  font-size: var(--fs-code);
  color: var(--text-secondary);
  cursor: pointer;
  text-align: left;
}

.agent-option:hover {
  background: var(--bg-hover);
}

.agent-option.active {
  font-weight: var(--weight-semibold);
}

.agent-option-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-option-status {
  font-size: var(--fs-caption);
  font-weight: var(--weight-medium);
  padding: 1px 5px;
  border-radius: 8px;
  text-transform: capitalize;
  flex-shrink: 0;
}

.agent-option-status.online { background: var(--bg-success); color: var(--text-success); }
.agent-option-status.idle { background: var(--bg-warning); color: var(--text-warning); }
.agent-option-status.busy { background: var(--bg-info); color: var(--text-info); }
.agent-option-status.offline { background: var(--bg-surface-alt); color: var(--text-muted); }

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
  color: var(--text-secondary);
  font-size: var(--fs-body-sm);
  cursor: pointer;
  transition: background 0.1s;
}

.model-trigger:hover {
  background: var(--bg-hover);
}

.model-label {
  white-space: nowrap;
  font-weight: var(--weight-medium);
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
  border: 1px solid var(--border-default);
  background: var(--bg-surface);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
}

.model-menu::-webkit-scrollbar { width: 6px; }
.model-menu::-webkit-scrollbar-thumb {
  background: var(--bg-surface-hover);
  border-radius: 3px;
}

.model-menu-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  font-size: var(--fs-caption);
  font-weight: var(--weight-semibold);
  text-transform: uppercase;
  letter-spacing: var(--tracking-wide);
  color: var(--text-muted);
  position: sticky;
  top: 0;
  background: var(--bg-surface);
  z-index: 1;
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
  color: var(--text-muted);
  cursor: pointer;
}

.model-menu-close:hover {
  background: var(--bg-hover);
}

.model-menu-loading {
  padding: 4px 10px;
  font-size: var(--fs-body-sm);
  color: var(--text-muted);
}

.model-menu-divider {
  height: 1px;
  background: var(--border-default);
  margin: 2px 0;
}

.model-group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  font-size: var(--fs-caption);
  font-weight: var(--weight-semibold);
  text-transform: uppercase;
  letter-spacing: var(--tracking-wide);
  color: var(--text-muted);
}

.model-primary-badge {
  font-size: var(--fs-caption);
  padding: 1px 5px;
  border-radius: 8px;
  background: var(--bg-info);
  color: var(--text-info);
  font-weight: var(--weight-semibold);
  text-transform: none;
  letter-spacing: 0;
}

.model-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 5px 10px;
  border: none;
  background: transparent;
  font-size: var(--fs-code);
  color: var(--text-secondary);
  cursor: pointer;
  text-align: left;
}

.model-option:hover {
  background: var(--bg-hover);
}

.model-option-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-option-active {
  font-size: var(--fs-caption);
  font-weight: var(--weight-medium);
  color: var(--text-muted);
  flex-shrink: 0;
}

.token-info {
  font-size: var(--fs-caption);
  color: var(--text-muted);
  white-space: nowrap;
}
</style>
