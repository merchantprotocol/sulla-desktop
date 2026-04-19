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
      <div class="chat-header-actions">
        <!-- History button -->
        <div class="chat-history-wrap">
          <button
            class="chat-history-btn"
            :class="{ dark: isDark, active: showHistory }"
            title="Chat History"
            @click="showHistory = !showHistory"
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
              <path d="M3 3v5h5" />
              <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
              <path d="M12 7v5l4 2" />
            </svg>
          </button>

          <!-- Chat History Dropdown Popup -->
          <div
            v-if="showHistory"
            class="chat-history-popup"
            :class="{ dark: isDark }"
          >
            <!-- Search Header -->
            <div
              class="chat-history-search-header"
              :class="{ dark: isDark }"
            >
              <div class="chat-history-search-box">
                <svg
                  class="chat-history-search-icon"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <circle
                    cx="11"
                    cy="11"
                    r="8"
                  />
                  <line
                    x1="21"
                    y1="21"
                    x2="16.65"
                    y2="16.65"
                  />
                </svg>
                <input
                  v-model="historySearchQuery"
                  type="text"
                  class="chat-history-search-input"
                  :class="{ dark: isDark }"
                  placeholder="Search"
                  @click.stop
                >
              </div>
            </div>

            <!-- History List -->
            <div class="chat-history-list">
              <div
                v-if="filteredHistory.length === 0"
                class="chat-history-empty"
              >
                No chat history
              </div>
              <div
                v-for="item in filteredHistory"
                :key="item.id"
                class="chat-history-item"
                :class="{ dark: isDark }"
                @click="loadHistoryItem(item.id)"
              >
                <svg
                  class="chat-history-check"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <span class="chat-history-item-title">{{ item.title }}</span>
                <span class="chat-history-item-time">{{ formatRelativeTime(item.lastMessageAt) }}</span>
                <button
                  class="chat-history-item-delete"
                  :class="{ dark: isDark }"
                  @click.stop="$emit('remove-history', item.id)"
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
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
            </div>
          </div>
        </div>
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
    </div>

    <!-- Click outside to close history popup -->
    <div
      v-if="showHistory"
      class="chat-history-backdrop"
      @click="showHistory = false"
    />

    <!-- Tab bar -->
    <div
      v-if="tabs && tabs.length > 0"
      class="chat-tabs"
      :class="{ dark: isDark }"
    >
      <div class="chat-tabs-list">
        <div
          v-for="tab in tabs"
          :key="tab.id"
          class="chat-tab"
          :class="{ active: tab.id === activeTabId, dark: isDark }"
          @click="$emit('switch-tab', tab.id)"
        >
          <span class="chat-tab-label">{{ tab.label }}</span>
          <button
            v-if="tabs.length > 1"
            class="chat-tab-close"
            :class="{ dark: isDark }"
            @click.stop="$emit('close-tab', tab.id)"
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
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
      </div>
      <button
        class="chat-tab-add"
        :class="{ dark: isDark }"
        title="New chat"
        @click="$emit('create-tab')"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <line
            x1="12"
            y1="5"
            x2="12"
            y2="19"
          />
          <line
            x1="5"
            y1="12"
            x2="19"
            y2="12"
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
        <ChatToolCard
          v-else-if="msg.kind === 'tool' && msg.toolCard"
          :tool-card="msg.toolCard"
          :is-dark="isDark"
        />

        <!-- Workflow node card -->
        <WorkflowNodeCard
          v-else-if="msg.kind === 'workflow_node' && msg.workflowNode"
          :node="msg.workflowNode"
          :is-dark="isDark"
        />

        <!-- Sub-agent activity bubble -->
        <SubAgentBubble
          v-else-if="msg.kind === 'sub_agent_activity' && msg.subAgentActivity"
          :activity="msg.subAgentActivity"
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

        <!-- HTML rich content bubble -->
        <div
          v-else-if="msg.kind === 'html'"
          class="bubble assistant-bubble"
          :class="{ dark: isDark }"
        >
          <HtmlMessageRenderer
            :content="msg.content"
            :is-dark="isDark"
          />
        </div>

        <!-- Assistant / system bubble (skip empty content) -->
        <div
          v-else-if="msg.content && msg.content.trim()"
          class="bubble assistant-bubble"
          :class="{ dark: isDark }"
        >
          <div
            class="bubble-content prose-content"
            v-html="renderMarkdown(msg.content)"
          />
        </div>
      </div>

      <!-- Queued Messages (like Windsurf) -->
      <div
        v-if="hasQueuedMessages"
        class="chat-queued-messages"
        :class="{ dark: isDark }"
      >
        <div class="chat-queue-header">
          <span class="chat-queue-title">Pending ({{ queuedMessageCount }})</span>
          <button
            type="button"
            class="chat-queue-clear"
            :class="{ dark: isDark }"
            @click="$emit('clear-queue')"
          >
            Clear all
          </button>
        </div>
        <div
          v-for="(msg, idx) in queuedMessages"
          :key="msg.id"
          class="chat-queued-item"
          :class="{ dark: isDark }"
        >
          <div class="chat-queued-content">
            {{ msg.content }}
          </div>
          <div class="chat-queued-actions">
            <button
              v-if="idx > 0"
              type="button"
              class="chat-queued-btn"
              :class="{ dark: isDark }"
              title="Move up"
              @click="$emit('move-up', msg.id)"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 15 15"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  d="M7.14645 2.14645C7.34171 1.95118 7.65829 1.95118 7.85355 2.14645L11.8536 6.14645C12.0488 6.34171 12.0488 6.65829 11.8536 6.85355C11.6583 7.04882 11.3417 7.04882 11.1464 6.85355L8 3.70711L8 12.5C8 12.7761 7.77614 13 7.5 13C7.22386 13 7 12.7761 7 12.5L7 3.70711L3.85355 6.85355C3.65829 7.04882 3.34171 7.04882 3.14645 6.85355C2.95118 6.65829 2.95118 6.34171 3.14645 6.14645L7.14645 2.14645Z"
                  fill="currentColor"
                  fill-rule="evenodd"
                  clip-rule="evenodd"
                />
              </svg>
            </button>
            <button
              v-if="idx < (queuedMessages?.length ?? 0) - 1"
              type="button"
              class="chat-queued-btn"
              :class="{ dark: isDark }"
              title="Move down"
              @click="$emit('move-down', msg.id)"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 15 15"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                style="transform: rotate(180deg)"
              >
                <path
                  d="M7.14645 2.14645C7.34171 1.95118 7.65829 1.95118 7.85355 2.14645L11.8536 6.14645C12.0488 6.34171 12.0488 6.65829 11.8536 6.85355C11.6583 7.04882 11.3417 7.04882 11.1464 6.85355L8 3.70711L8 12.5C8 12.7761 7.77614 13 7.5 13C7.22386 13 7 12.7761 7 12.5L7 3.70711L3.85355 6.85355C3.65829 7.04882 3.34171 7.04882 3.14645 6.85355C2.95118 6.65829 2.95118 6.34171 3.14645 6.14645L7.14645 2.14645Z"
                  fill="currentColor"
                  fill-rule="evenodd"
                  clip-rule="evenodd"
                />
              </svg>
            </button>
            <button
              type="button"
              class="chat-queued-btn remove"
              :class="{ dark: isDark }"
              title="Remove"
              @click="$emit('remove', msg.id)"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 15 15"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  d="M11.7816 4.03157C12.0724 3.74081 12.0724 3.25991 11.7816 2.96915C11.4909 2.67839 11.0099 2.67839 10.7192 2.96915L7.50005 6.18827L4.28091 2.96915C3.99015 2.67839 3.50925 2.67839 3.21849 2.96915C2.92773 3.25991 2.92773 3.74081 3.21849 4.03157L6.43761 7.25071L3.21849 10.4698C2.92773 10.7606 2.92773 11.2415 3.21849 11.5323C3.50925 11.823 3.99015 11.823 4.28091 11.5323L7.50005 8.31315L10.7192 11.5323C11.0099 11.823 11.4909 11.823 11.7816 11.5323C12.0724 11.2415 12.0724 10.7606 11.7816 10.4698L8.56248 7.25071L11.7816 4.03157Z"
                  fill="currentColor"
                  fill-rule="evenodd"
                  clip-rule="evenodd"
                />
              </svg>
            </button>
          </div>
        </div>
      </div>

      <!-- Activity status indicator -->
      <div
        v-if="showActivity"
        class="chat-activity-status"
      >
        <span class="activity-dot" />
        <span class="activity-text">{{ currentActivity || (props.modelLoading ? 'Initializing model' : 'Thinking') }}..<span class="blink-dot">.</span></span>
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
        <!-- Stop button: only when busy AND no text typed -->
        <button
          v-if="isBusy && !query.trim()"
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
        <!-- Send button: always when there's text (allows queuing when busy) -->
        <button
          v-if="query.trim()"
          class="chat-send-btn"
          :class="{ dark: isDark }"
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
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { ref, watch, nextTick, computed, onMounted } from 'vue';

import SubAgentBubble from './workflow/SubAgentBubble.vue';
import WorkflowNodeCard from './workflow/WorkflowNodeCard.vue';

import type { ChatMessage } from '@pkg/agent';
import type { AgentPersonaRegistry } from '@pkg/agent/database/registry/AgentPersonaRegistry';
import ChatToolCard from '@pkg/components/ChatToolCard.vue';
import HtmlMessageRenderer from '@pkg/components/HtmlMessageRenderer.vue';
import type { AgentModelSelectorController } from '@pkg/pages/agent/AgentModelSelectorController';

import type { ChatHistoryItem } from './EditorChatTabsInterface';
import type { QueuedMessage } from '../agent/ChatMessageQueue';

const props = defineProps<{
  isDark:              boolean;
  messages:            ChatMessage[];
  query:               string;
  loading:             boolean;
  graphRunning:        boolean;
  modelLoading?:       boolean;  // New: model initializing state
  waitingForUser?:     boolean;
  currentActivity?:    string;
  modelSelector?:      AgentModelSelectorController;
  agentRegistry?:      AgentPersonaRegistry;
  totalTokensUsed?:    number;
  hideAgentSelector?:  boolean;
  queuedMessages?:     QueuedMessage[];
  hasQueuedMessages?:  boolean;
  queuedMessageCount?: number;
  // Tab system props
  tabs?:               { id: string; label: string; messageCount: number; isActive: boolean }[];
  activeTabId?:        string;
  // Chat history props
  chatHistory?:        ChatHistoryItem[];
}>();

const showAgentMenu = ref(false);
const showHistory = ref(false);
const historySearchQuery = ref('');

// Computed property for any busy state (loading, running, or initializing)
const isBusy = computed(() => props.loading || props.graphRunning || props.modelLoading);

// Computed property for showing activity (includes queued messages as indicator of processing)
const showActivity = computed(() => isBusy.value || props.hasQueuedMessages);

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
  'update:query':   [value: string];
  send:             [];
  stop:             [];
  close:            [];
  remove:           [messageId: string];
  'clear-queue':    [];
  'move-up':        [messageId: string];
  'move-down':      [messageId: string];
  // Tab system events
  'create-tab':     [];
  'switch-tab':     [tabId: string];
  'close-tab':      [tabId: string];
  'rename-tab':     [tabId: string, newLabel: string];
  // Chat history events
  'load-history':   [historyId: string];
  'remove-history': [historyId: string];
  'clear-history':  [];
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

// Auto-scroll state - only scroll if user is near bottom
const autoScrollEnabled = ref(true);
let isUserScrolling = false;
let scrollTimeout: ReturnType<typeof setTimeout> | null = null;
const SCROLL_THRESHOLD = 100; // pixels from bottom to trigger auto-scroll

function attachScrollListeners(container: HTMLElement) {
  const startScroll = () => { isUserScrolling = true };
  const endScroll = () => {
    if (scrollTimeout) clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => { isUserScrolling = false }, 150);
  };
  container.addEventListener('wheel', startScroll, { passive: true });
  container.addEventListener('wheel', endScroll, { passive: true });
  container.addEventListener('touchstart', startScroll, { passive: true });
  container.addEventListener('touchend', endScroll, { passive: true });
  container.addEventListener('scroll', () => {
    if (!isUserScrolling) return;
    const dist = container.scrollHeight - container.scrollTop - container.clientHeight;
    autoScrollEnabled.value = dist <= SCROLL_THRESHOLD;
  }, { passive: true });
}

function renderMarkdown(content: string): string {
  const raw = typeof content === 'string' ? content : String(content || '');
  const html = (marked(raw) as string) || '';
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

function scrollToBottom(force = false) {
  nextTick(() => {
    const container = messagesEl.value;
    if (!container) return;
    // Only scroll if auto-scroll is enabled or forced
    if (!autoScrollEnabled.value && !force) return;
    container.scrollTop = container.scrollHeight;
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

function loadHistoryItem(historyId: string) {
  showHistory.value = false;
  emit('load-history', historyId);
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();

  if (isToday) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  const isThisYear = date.getFullYear() === now.getFullYear();
  if (isThisYear) {
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'now';
  if (minutes < 60) return `${ minutes }m`;
  if (hours < 24) return `${ hours }h`;
  if (days < 30) return `${ days }d`;

  return `${ Math.floor(days / 30) }mo`;
}

// Filtered history based on search
const filteredHistory = computed(() => {
  const history = props.chatHistory || [];
  if (!historySearchQuery.value.trim()) return history;

  const query = historySearchQuery.value.toLowerCase();
  return history.filter(item =>
    item.title.toLowerCase().includes(query) ||
    item.preview.toLowerCase().includes(query),
  );
});

// Auto-scroll on new messages - only if user is near bottom
watch(() => props.messages.length, () => scrollToBottom());

// Auto-scroll when a message is enqueued
watch(() => props.queuedMessages?.length, () => scrollToBottom());

// Auto-scroll during streaming or thinking (when last message content updates)
watch(
  () => {
    const msgs = props.messages;
    const last = msgs.length > 0 ? msgs[msgs.length - 1] : null;
    return (last?.kind === 'streaming' || last?.kind === 'thinking') ? last.content : null;
  },
  () => scrollToBottom(),
  { flush: 'post' },
);

// Scroll to bottom on mount if there are existing messages (e.g., after page refresh)
onMounted(() => {
  if (messagesEl.value) attachScrollListeners(messagesEl.value);
  if (props.messages.length > 0) {
    scrollToBottom(true); // Force scroll on mount
  }
});
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

/* Theme-aware scrollbar styling for chat-messages */
.chat-messages::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

.chat-messages::-webkit-scrollbar-track {
  background: var(--bg-surface);
  border-radius: 4px;
}

.chat-messages::-webkit-scrollbar-thumb {
  background: var(--border-default);
  border-radius: 4px;
  transition: background-color 150ms;
}

.chat-messages::-webkit-scrollbar-thumb:hover {
  background: var(--text-muted);
}

.chat-messages::-webkit-scrollbar-corner {
  background: var(--bg-surface);
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

/* Tool card styles are in ChatToolCard.vue */

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
  /* Hide scrollbar */
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.chat-input::-webkit-scrollbar {
  display: none;
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

/* ─── Queued Messages ─── */
.chat-queued-messages {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 12px;
  border-top: 1px dashed var(--border-default);
}

.chat-queue-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 4px;
}

.chat-queue-title {
  font-size: var(--fs-caption);
  font-weight: var(--weight-semibold);
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: var(--tracking-wide);
}

.chat-queue-clear {
  font-size: var(--fs-caption);
  color: var(--text-muted);
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
}

.chat-queue-clear:hover {
  color: var(--text-secondary);
  background: var(--bg-hover);
}

.chat-queued-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--bg-surface-alt);
  border: 1px dashed var(--border-default);
  border-radius: 8px;
  opacity: 0.8;
}

.chat-queued-content {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-code);
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  -webkit-box-orient: vertical;
}

.chat-queued-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

.chat-queued-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}

.chat-queued-btn:hover {
  background: var(--bg-hover);
  color: var(--text-secondary);
}

.chat-queued-btn.remove:hover {
  background: var(--bg-error);
  color: var(--text-error);
}

/* ─── Chat Tabs ─── */
.chat-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-default);
  flex-shrink: 0;
  overflow-x: auto;
}

.chat-tabs-list {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  /* Scrollbar hidden by default, shows on hover */
  scrollbar-width: thin;
  scrollbar-color: transparent transparent;
}

/* Firefox: show scrollbar on hover */
.chat-tabs-list:hover {
  scrollbar-color: var(--bg-surface-hover) transparent;
}

/* WebKit: custom scrollbar */
.chat-tabs-list::-webkit-scrollbar {
  height: 6px;
}

.chat-tabs-list::-webkit-scrollbar-track {
  background: transparent;
}

/* Thumb hidden by default */
.chat-tabs-list::-webkit-scrollbar-thumb {
  background: transparent;
  border-radius: 3px;
}

/* Show thumb on hover with theme colors */
.chat-tabs-list:hover::-webkit-scrollbar-thumb {
  background: var(--bg-surface-hover);
  border-radius: 3px;
}

.chat-tabs-list:hover::-webkit-scrollbar-thumb:hover {
  background: var(--border-strong);
}

.chat-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 6px;
  background: var(--bg-surface-alt);
  border: 1px solid var(--border-default);
  cursor: pointer;
  font-size: var(--fs-body-sm);
  color: var(--text-secondary);
  white-space: nowrap;
  transition: all 0.15s ease;
}

.chat-tab:hover {
  background: var(--bg-hover);
}

.chat-tab.active {
  background: var(--bg-info);
  color: var(--text-info);
  border-color: var(--accent-primary);
}

.chat-tab-label {
  max-width: 100px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chat-tab-badge {
  font-size: var(--fs-caption);
  padding: 1px 5px;
  border-radius: 10px;
  background: var(--bg-surface);
  color: var(--text-muted);
  min-width: 18px;
  text-align: center;
}

.chat-tab.active .chat-tab-badge {
  background: var(--accent-primary);
  color: var(--text-on-accent);
}

.chat-tab-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  opacity: 0.6;
}

.chat-tab-close:hover {
  background: var(--bg-error);
  color: var(--text-error);
  opacity: 1;
}

.chat-tab-add {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  flex-shrink: 0;
}

.chat-tab-add:hover {
  background: var(--bg-hover);
  color: var(--text-secondary);
}

/* Hide scrollbar on main tabs container too */
.chat-tabs {
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.chat-tabs::-webkit-scrollbar {
  display: none;
}

/* ─── Chat History Popup (Dropdown) ─── */
.chat-history-wrap {
  position: relative;
}

.chat-history-backdrop {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 9998;
}

.chat-history-popup {
  position: fixed;
  top: 44px;
  right: 12px;
  width: 320px;
  max-width: calc(100vw - 24px);
  max-height: min(350px, calc(100vh - 60px));
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: 10px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  z-index: 9999;
}

/* Search Header */
.chat-history-search-header {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-default);
  background: var(--bg-surface);
  flex-shrink: 0;
}

.chat-history-search-box {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--bg-surface-alt);
  border: 1px solid var(--border-default);
  border-radius: 6px;
}

.chat-history-search-icon {
  color: var(--text-muted);
  flex-shrink: 0;
}

.chat-history-search-input {
  flex: 1;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: var(--fs-body-sm);
  outline: none;
  min-width: 0;
}

.chat-history-search-input::placeholder {
  color: var(--text-muted);
}

/* History List */
.chat-history-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
}

.chat-history-empty {
  text-align: center;
  padding: 30px 16px;
  color: var(--text-muted);
  font-size: var(--fs-body-sm);
}

.chat-history-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.chat-history-item:hover {
  background: var(--bg-hover);
}

.chat-history-check {
  color: var(--text-muted);
  flex-shrink: 0;
  width: 12px;
  height: 12px;
}

.chat-history-item-title {
  flex: 1;
  font-size: var(--fs-body-sm);
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.chat-history-item-time {
  font-size: var(--fs-caption);
  color: var(--text-muted);
  flex-shrink: 0;
}

.chat-history-item-delete {
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
  opacity: 0;
  transition: opacity 0.15s;
  flex-shrink: 0;
}

.chat-history-item:hover .chat-history-item-delete {
  opacity: 1;
}

.chat-history-item-delete:hover {
  background: var(--bg-error);
  color: var(--text-error);
}

/* History button active state */
.chat-history-btn.active {
  background: var(--bg-hover);
  color: var(--text-secondary);
}

/* Header actions container */
.chat-header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

/* History button */
.chat-history-btn {
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

.chat-history-btn:hover {
  background: var(--bg-hover);
  color: var(--text-secondary);
}
</style>
