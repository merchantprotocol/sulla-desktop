<template>
  <div class="flex h-full flex-col" style="background: var(--bg, #0d1117);">
    <!-- ════════════════════════════════════════════════════════════
         WELCOME — shown before any session starts
         ════════════════════════════════════════════════════════════ -->
    <template v-if="!isListening && !hasSessionEnded">
      <div class="welcome-scroll">
        <div class="welcome-inner">
          <h1 class="welcome-title">Secretary Mode</h1>
          <p class="welcome-subtitle">Click below or press <kbd class="dt-kbd">{{ isMac ? '⌘' : 'Ctrl' }}+Shift+S</kbd> to start recording.</p>
          <p class="welcome-subtitle">Say <strong>"Hey Sulla"</strong> during a session to interact.</p>

          <!-- Terminal preview card (clickable) -->
          <div class="welcome-card" @click="startSession">
            <div class="dt-header">
              <div class="dt-traffic">
                <span class="dt-dot-w dt-dot-red" />
                <span class="dt-dot-w dt-dot-yellow" />
                <span class="dt-dot-w dt-dot-green" />
              </div>
              <span class="dt-title">sulla — secretary</span>
              <div class="dt-rec">
                <span class="dt-rec-dot" />
                REC 12:34
              </div>
            </div>
            <div class="dt-body">
              <div class="dt-left">
                <div class="dt-line"><span class="dt-ts">12:30:01</span> We need to finalize the API contract before Friday.</div>
                <div class="dt-line"><span class="dt-ts">12:30:18</span> Sarah will handle the auth endpoints.</div>
                <div class="dt-line"><span class="dt-ts">12:30:45</span> Let's use JWT with short-lived tokens.</div>
                <div class="dt-line dt-dim"><span class="dt-ts">12:31:02</span> Listening...</div>
              </div>
              <div class="dt-divider" />
              <div class="dt-right">
                <div class="dt-section-hdr">ACTION ITEMS</div>
                <div class="dt-item"><span class="dt-bullet" /> Sarah: auth endpoints by Friday</div>
                <div class="dt-item"><span class="dt-bullet" /> Finalize API contract</div>
                <div class="dt-section-hdr">DECISIONS</div>
                <div class="dt-item dt-decision">JWT with short-lived tokens</div>
                <div class="dt-section-hdr">INSIGHTS</div>
                <div class="dt-item dt-insight">Deadline pressure — Friday target mentioned</div>
              </div>
            </div>
            <div class="welcome-card-cta">Click to start session</div>
          </div>
        </div>
      </div>
    </template>

    <!-- ════════════════════════════════════════════════════════════
         ACTIVE SESSION — Terminal design
         ════════════════════════════════════════════════════════════ -->
    <template v-else>
      <!-- Terminal header with traffic lights -->
      <div class="dt-header dt-header-live">
        <div class="dt-traffic">
          <span class="dt-dot-w dt-dot-red" />
          <span class="dt-dot-w dt-dot-yellow" />
          <span class="dt-dot-w dt-dot-green" />
        </div>
        <span class="dt-title">sulla — secretary</span>
        <div class="dt-header-right">
          <!-- Audio level bars -->
          <div v-if="isListening" class="dt-level-bars">
            <div
              v-for="i in 5"
              :key="i"
              class="dt-level-bar"
              :class="{ active: audioLevel >= i * 20 }"
            />
          </div>
          <div v-if="isListening" class="dt-rec">
            <span class="dt-rec-dot" />
            REC {{ sessionDuration }}
          </div>
          <span v-if="wakeWordActive" class="dt-wake-indicator">WAKE</span>
          <button
            v-if="isListening"
            class="dt-btn"
            :class="isMuted ? 'dt-btn-muted' : 'dt-btn-unmuted'"
            @click="toggleMute"
          >
            {{ isMuted ? 'UNMUTE' : 'MUTE' }}
          </button>
          <button
            v-if="isListening"
            class="dt-btn dt-btn-stop"
            @click="endSession"
          >
            END
          </button>
          <button
            v-if="!isListening && hasSessionEnded"
            class="dt-btn dt-btn-new"
            @click="resetAndChoose"
          >
            NEW
          </button>
        </div>
      </div>

      <!-- Terminal body: transcript left, notes right -->
      <div class="dt-body dt-body-live">
        <!-- LEFT: Meeting transcript -->
        <div class="dt-pane-left">
          <div class="dt-pane-hdr">
            <span>MEETING TRANSCRIPT</span>
            <span class="dt-pane-count">{{ transcript.length }}</span>
          </div>
          <div ref="transcriptScrollEl" class="dt-pane-scroll dt-timeline">
            <div
              v-for="entry in transcript"
              :key="entry.id"
              class="dt-turn"
              :class="{ 'dt-turn-wake': entry.type === 'wake-command' }"
            >
              <div
                class="dt-turn-bar"
                :style="{ background: getSpeakerColor(entry.speaker || 'Unknown') }"
              />
              <div class="dt-turn-content">
                <div class="dt-turn-header">
                  <span
                    class="dt-turn-speaker"
                    :style="{ color: getSpeakerColor(entry.speaker || 'Unknown') }"
                  >{{ entry.speaker || 'Speaker' }}</span>
                  <span class="dt-turn-time">{{ formatTime(entry.timestamp) }}</span>
                </div>
                <div class="dt-turn-text">{{ entry.text }}</div>
              </div>
            </div>
            <div v-if="isListening && transcript.length === 0" class="dt-turn">
              <div class="dt-turn-bar" style="background: var(--text-dim, #6e7681);" />
              <div class="dt-turn-content">
                <div class="dt-turn-text dt-dim">Listening...</div>
              </div>
            </div>
          </div>
        </div>

        <div class="dt-divider" />

        <!-- RIGHT: Sulla's notes -->
        <div class="dt-pane-right">
          <div class="dt-pane-hdr">
            <span>SULLA'S NOTES</span>
            <span v-if="isAnalyzing" class="dt-analyzing">
              <span class="dt-rec-dot" style="background: var(--accent-primary, #5096b3);" />
              ANALYZING
            </span>
          </div>
          <div ref="analysisScrollEl" class="dt-pane-scroll">
            <template v-if="actionItems.length === 0 && decisions.length === 0 && insights.length === 0 && agentMessages.length === 0">
              <div class="dt-empty">Waiting for conversation...</div>
            </template>

            <template v-if="actionItems.length > 0">
              <div class="dt-section-hdr">ACTION ITEMS</div>
              <div v-for="(item, idx) in actionItems" :key="'a' + idx" class="dt-item">
                <span class="dt-bullet" /> {{ item }}
              </div>
            </template>

            <template v-if="decisions.length > 0">
              <div class="dt-section-hdr">DECISIONS</div>
              <div v-for="(item, idx) in decisions" :key="'d' + idx" class="dt-item dt-decision">
                {{ item }}
              </div>
            </template>

            <template v-if="insights.length > 0">
              <div class="dt-section-hdr">INSIGHTS</div>
              <div v-for="(item, idx) in insights" :key="'i' + idx" class="dt-item dt-insight">
                <span class="dt-insight-time">{{ item.time }}</span> {{ item.text }}
              </div>
            </template>

            <template v-if="agentMessages.length > 0">
              <div class="dt-section-hdr">COMMENTARY</div>
              <div v-for="msg in agentMessages" :key="msg.id" class="dt-item dt-insight">
                <span class="dt-insight-time">{{ msg.time }}</span> {{ msg.text }}
              </div>
            </template>
          </div>

          <!-- Chat input pinned to bottom of notes pane -->
          <div class="dt-chat-input">
            <input
              ref="chatInputEl"
              v-model="chatInput"
              type="text"
              class="dt-chat-field"
              placeholder="Message Sulla privately..."
              @keydown.enter="sendChatMessage"
            >
            <button
              class="dt-chat-send"
              :disabled="!chatInput.trim()"
              @click="sendChatMessage"
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, onUnmounted, nextTick } from 'vue';
import { useBrowserTabs, type BrowserTabMode } from '@pkg/composables/useBrowserTabs';
import { ChatInterface } from './agent/ChatInterface';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import {
  SecretaryModeController,
  type TranscriptEntry,
  type InsightEntry,
  type AgentMessage,
} from '@pkg/controllers/SecretaryModeController';

const props = defineProps<{ tabId: string }>();
const emit = defineEmits<{ 'set-mode': [mode: BrowserTabMode] }>();

const { updateTab } = useBrowserTabs();

const isMac = navigator.platform.toUpperCase().includes('MAC');

// ── Reactive state (View owns this) ────────────────────────────

const hasSessionEnded = ref(false);
const transcript = ref<TranscriptEntry[]>([]);
const isListening = ref(false);
const wakeWordActive = ref(false);
const audioLevel = ref(0);
const sessionDuration = ref('0:00');
const isAnalyzing = ref(false);
const isMuted = ref(false);
const chatInput = ref('');
const chatInputEl = ref<HTMLInputElement | null>(null);
const transcriptScrollEl = ref<HTMLElement | null>(null);
const analysisScrollEl = ref<HTMLElement | null>(null);

const actionItems = ref<string[]>([]);
const decisions = ref<string[]>([]);
const insights = ref<InsightEntry[]>([]);
const agentMessages = ref<AgentMessage[]>([]);

// ── TTS state (view-owned, browser APIs) ────────────────────────

let activeTTSAudio: HTMLAudioElement | null = null;
let activeTTSUtterance: SpeechSynthesisUtterance | null = null;

function stopTTS(): void {
  if (activeTTSAudio) {
    activeTTSAudio.pause();
    activeTTSAudio.currentTime = 0;
    if (activeTTSAudio.src) URL.revokeObjectURL(activeTTSAudio.src);
    activeTTSAudio = null;
  }
  if (activeTTSUtterance) {
    window.speechSynthesis?.cancel();
    activeTTSUtterance = null;
  }
  controller?.setTTSActive(false);
}

function toggleMute(): void {
  isMuted.value = !isMuted.value;
  if (isMuted.value) {
    // Immediately kill all playing audio
    stopTTS();
    controller?.stopAgentAudio();
  }
}

async function playTTS(text: string): Promise<void> {
  if (isMuted.value) return;
  stopTTS();

  try {
    const result = await ipcRenderer.invoke('audio-speak', { text });
    if (result?.audio) {
      const blob = new Blob([result.audio], { type: result.mimeType || 'audio/mpeg' });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      activeTTSAudio = audio;
      controller?.setTTSActive(true);
      audio.onended = () => { URL.revokeObjectURL(url); activeTTSAudio = null; controller?.setTTSActive(false); };
      audio.onerror = () => { URL.revokeObjectURL(url); activeTTSAudio = null; controller?.setTTSActive(false); };
      await audio.play().catch(() => { activeTTSAudio = null; controller?.setTTSActive(false); });
    }
  } catch {
    if (window.speechSynthesis) {
      const utterance = new SpeechSynthesisUtterance(text);
      activeTTSUtterance = utterance;
      controller?.setTTSActive(true);
      utterance.onend = () => { activeTTSUtterance = null; controller?.setTTSActive(false); };
      window.speechSynthesis.speak(utterance);
    }
  }
}

// ── Chat interface (view-owned, bridges to controller) ──────────

let chatInterface: ChatInterface | null = null;

function ensureChatInterface(): ChatInterface {
  if (!chatInterface) {
    chatInterface = new ChatInterface('sulla-desktop', props.tabId);
    if (!chatInterface.threadId.value) {
      chatInterface.newChat();
    }
  }
  return chatInterface;
}

async function sendToChat(prompt: string, inputSource: string): Promise<string | null> {
  const ci = ensureChatInterface();
  ci.query.value = prompt;
  const voiceMode = inputSource === 'secretary-analysis' ? 'secretary' : undefined;
  await ci.send({ inputSource, ...(voiceMode ? { voiceMode } : {}) });

  return new Promise<string | null>((resolve) => {
    const msgCountBefore = ci.messages.value.length;
    const stopWatch = setInterval(() => {
      if (!chatInterface) { clearInterval(stopWatch); resolve(null); return; }
      const msgs = chatInterface.messages.value;
      if (msgs.length > msgCountBefore) {
        const lastMsg = msgs[msgs.length - 1];
        if (lastMsg && lastMsg.role === 'assistant' && lastMsg.content && !chatInterface.graphRunning.value) {
          clearInterval(stopWatch);
          resolve(lastMsg.content);
        }
      }
    }, 500);

    setTimeout(() => { clearInterval(stopWatch); resolve(null); }, 60_000);
  });
}

// ── View helpers ────────────────────────────────────────────────

function generateEntryId(): string {
  return `se_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatTimeNowFull(): string {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ── Speaker color assignment (up to 12 distinct colors) ──────
const SPEAKER_COLORS = [
  '#58a6ff', // blue
  '#3fb950', // green
  '#d2a8ff', // purple
  '#f0883e', // orange
  '#f778ba', // pink
  '#79c0ff', // light blue
  '#7ee787', // light green
  '#d29922', // yellow
  '#ff7b72', // red
  '#a5d6ff', // sky
  '#ffa657', // peach
  '#bc8cff', // lavender
];
const speakerColorMap = new Map<string, string>();

function getSpeakerColor(speaker: string): string {
  const key = speaker.toLowerCase();
  if (speakerColorMap.has(key)) return speakerColorMap.get(key)!;
  const color = SPEAKER_COLORS[speakerColorMap.size % SPEAKER_COLORS.length];
  speakerColorMap.set(key, color);
  return color;
}

function scrollAnalysis(): void {
  nextTick(() => {
    if (analysisScrollEl.value) {
      analysisScrollEl.value.scrollTop = analysisScrollEl.value.scrollHeight;
    }
  });
}

function resetAndChoose(): void {
  hasSessionEnded.value = false;
  transcript.value = [];
  actionItems.value = [];
  decisions.value = [];
  insights.value = [];
  agentMessages.value = [];
  sessionDuration.value = '0:00';
}

// ── Controller (all business logic) ────────────────────────────

const controller = new SecretaryModeController({
  addEntry(text: string, type: TranscriptEntry['type'] = 'transcript', speaker?: string) {
    transcript.value.push({ id: generateEntryId(), timestamp: new Date(), text, type, speaker });
    nextTick(() => {
      if (transcriptScrollEl.value) {
        transcriptScrollEl.value.scrollTop = transcriptScrollEl.value.scrollHeight;
      }
    });
  },
  setWakeWordActive:  (v) => { wakeWordActive.value = v; },
  getWakeWordActive:  () => wakeWordActive.value,
  setAudioLevel:      (v) => { audioLevel.value = v; },
  setSessionDuration: (v) => { sessionDuration.value = v; },
  setIsListening:     (v) => { isListening.value = v; },
  getIsListening:     () => isListening.value,
  setIsAnalyzing:     (v) => { isAnalyzing.value = v; },
  getIsMuted:         () => isMuted.value,
  getTranscript:      () => transcript.value,
  addActionItem:      (item) => { actionItems.value.push(item); },
  getActionItems:     () => actionItems.value,
  addDecision:        (item) => { decisions.value.push(item); },
  getDecisions:       () => decisions.value,
  addInsight:         (entry) => { insights.value.push(entry); },
  addAgentMessage:    (msg) => { agentMessages.value.push(msg); },
  scrollAnalysis,
  playTTS,
  stopTTS,
  sendToChat,
});

// ── Session lifecycle (thin wrappers) ──────────────────────────

async function startSession(): Promise<void> {
  try {
    isListening.value = true;
    hasSessionEnded.value = false;
    actionItems.value = [];
    decisions.value = [];
    insights.value = [];
    agentMessages.value = [];
    updateTab(props.tabId, { title: 'Secretary - Recording' });

    await controller.startSession();
  } catch (err) {
    console.error('[SecretaryMode] Failed to start session:', err);
    isListening.value = false;
  }
}

function endSession(): void {
  isListening.value = false;
  hasSessionEnded.value = true;
  controller.endSession();
  updateTab(props.tabId, { title: `Secretary - ${sessionDuration.value}` });
}

async function sendChatMessage(): Promise<void> {
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';
  await controller.sendChatMessage(text);
}

// ── Lifecycle ──────────────────────────────────────────────────

onUnmounted(() => {
  if (isListening.value) endSession();
  controller.dispose();
  chatInterface?.dispose();
  chatInterface = null;
});
</script>

<style scoped>
/* ════════════════════════════════════════════════════════════════
   WELCOME PAGE
   ════════════════════════════════════════════════════════════════ */

.welcome-scroll {
  flex: 1;
  overflow-y: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem;
}

.welcome-inner {
  max-width: 700px;
  width: 100%;
  text-align: center;
}

.welcome-title {
  font-family: 'SF Mono', 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 24px;
  font-weight: 600;
  color: var(--text, #e6edf3);
  margin-bottom: 0.5rem;
}

.welcome-subtitle {
  font-size: 12px;
  color: var(--text-dim, #6e7681);
  margin-bottom: 0.25rem;
}

.welcome-card {
  margin-top: 1.5rem;
  border-radius: 10px;
  border: 1px solid var(--border, #30363d);
  background: var(--bg, #0d1117);
  overflow: hidden;
  cursor: pointer;
  transition: border-color 200ms, box-shadow 200ms;
}

.welcome-card:hover {
  border-color: var(--accent-primary, #5096b3);
  box-shadow: 0 0 15px rgba(80, 150, 179, 0.2), 0 0 30px rgba(80, 150, 179, 0.1);
}

.welcome-card-cta {
  padding: 0.625rem;
  text-align: center;
  font-family: 'SF Mono', 'JetBrains Mono', monospace;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.04em;
  color: var(--accent-primary, #5096b3);
  background: var(--surface-2, #1c2128);
  border-top: 1px solid var(--border-muted, #21262d);
}

/* ════════════════════════════════════════════════════════════════
   TERMINAL DESIGN — shared between preview and live session
   ════════════════════════════════════════════════════════════════ */

.dt-header {
  display: flex;
  align-items: center;
  padding: 0.5rem 0.75rem;
  background: var(--surface-2, #1c2128);
  border-bottom: 1px solid var(--border-muted, #21262d);
  flex-shrink: 0;
}

.dt-header-live {
  padding: 0.5rem 1rem;
}

.dt-traffic {
  display: flex;
  gap: 5px;
  margin-right: 0.75rem;
}

.dt-dot-w {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.dt-dot-red { background: #ff5f57; }
.dt-dot-yellow { background: #febc2e; }
.dt-dot-green { background: #28c840; }

.dt-title {
  flex: 1;
  text-align: center;
  font-family: 'SF Mono', 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 11px;
  color: var(--text-dim, #6e7681);
}

.dt-header-right {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.dt-rec {
  display: flex;
  align-items: center;
  gap: 4px;
  font-family: 'SF Mono', 'JetBrains Mono', monospace;
  font-size: 10px;
  color: var(--red, #f85149);
}

.dt-rec-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--red, #f85149);
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.dt-wake-indicator {
  font-family: 'SF Mono', 'JetBrains Mono', monospace;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.08em;
  padding: 0.125rem 0.375rem;
  border-radius: 3px;
  color: var(--accent-primary, #5096b3);
  background: rgba(80, 150, 179, 0.15);
  border: 1px solid rgba(80, 150, 179, 0.3);
  animation: pulse 1s ease-in-out infinite;
}

.dt-level-bars {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 14px;
}

.dt-level-bar {
  width: 2px;
  border-radius: 1px;
  background: var(--text-dim, #6e7681);
  transition: height 100ms, background-color 100ms;
  height: 3px;
}

.dt-level-bar.active { background: var(--green-bright, #3FB950); }
.dt-level-bar:nth-child(1).active { height: 4px; }
.dt-level-bar:nth-child(2).active { height: 7px; }
.dt-level-bar:nth-child(3).active { height: 10px; }
.dt-level-bar:nth-child(4).active { height: 12px; }
.dt-level-bar:nth-child(5).active { height: 14px; }

.dt-btn {
  font-family: 'SF Mono', 'JetBrains Mono', monospace;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  padding: 0.25rem 0.625rem;
  border-radius: 4px;
  border: 1px solid;
  cursor: pointer;
  transition: background-color 150ms, box-shadow 150ms;
}

.dt-btn-stop {
  color: var(--red, #f85149);
  border-color: rgba(248, 81, 73, 0.3);
  background: rgba(248, 81, 73, 0.1);
}

.dt-btn-stop:hover {
  background: rgba(248, 81, 73, 0.2);
  box-shadow: 0 0 8px rgba(248, 81, 73, 0.2);
}

.dt-btn-new {
  color: var(--accent-primary, #5096b3);
  border-color: rgba(80, 150, 179, 0.3);
  background: rgba(80, 150, 179, 0.1);
}

.dt-btn-new:hover {
  background: rgba(80, 150, 179, 0.2);
  box-shadow: 0 0 8px rgba(80, 150, 179, 0.2);
}

.dt-btn-unmuted {
  color: var(--accent-primary, #5096b3);
  border-color: rgba(80, 150, 179, 0.3);
  background: rgba(80, 150, 179, 0.1);
}

.dt-btn-unmuted:hover {
  background: rgba(80, 150, 179, 0.2);
}

.dt-btn-muted {
  color: var(--yellow, #d29922);
  border-color: rgba(210, 153, 34, 0.3);
  background: rgba(210, 153, 34, 0.1);
}

.dt-btn-muted:hover {
  background: rgba(210, 153, 34, 0.2);
}

/* ── Body / split ────────────────────────────────────────── */

.dt-body {
  display: flex;
  min-height: 0;
  font-family: 'SF Mono', 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 11px;
}

.dt-body-live {
  flex: 1;
  overflow: hidden;
}

.dt-divider {
  width: 1px;
  background: var(--border, #30363d);
  flex-shrink: 0;
}

/* ── Preview (welcome card) panes ────────────────────────── */

.dt-left {
  flex: 1;
  padding: 0.75rem;
  min-height: 160px;
}

.dt-right {
  flex: 1;
  padding: 0.75rem;
}

.dt-line {
  color: var(--text-muted, #8b949e);
  margin-bottom: 0.375rem;
  line-height: 1.6;
}

.dt-line.dt-dim {
  color: var(--text-dim, #6e7681);
}

.dt-ts {
  color: var(--text-dim, #6e7681);
  margin-right: 0.75rem;
}

/* ── Live session panes ──────────────────────────────────── */

.dt-pane-left {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.dt-pane-right {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.dt-pane-hdr {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.375rem 0.75rem;
  font-family: 'SF Mono', 'JetBrains Mono', monospace;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--text-dim, #6e7681);
  background: var(--surface-1, #161b22);
  border-bottom: 1px solid var(--border-muted, #21262d);
  flex-shrink: 0;
}

.dt-pane-count {
  font-weight: 400;
  color: var(--text-dim, #6e7681);
}

.dt-analyzing {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--accent-primary, #5096b3);
}

.dt-pane-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0.75rem;
}

.dt-empty {
  color: var(--text-dim, #6e7681);
  font-style: italic;
  padding: 0.5rem 0;
}

/* ── Meeting transcript turns ─────────────────────────── */

.dt-timeline {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.dt-turn {
  display: flex;
  gap: 0.5rem;
  padding: 0.375rem 0;
  border-bottom: 1px solid var(--border-muted, #21262d);
}

.dt-turn:last-child {
  border-bottom: none;
}

.dt-turn-wake {
  background: rgba(80, 150, 179, 0.06);
}

.dt-turn-bar {
  width: 3px;
  min-width: 3px;
  border-radius: 2px;
  flex-shrink: 0;
}

.dt-turn-content {
  flex: 1;
  min-width: 0;
}

.dt-turn-header {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  margin-bottom: 0.125rem;
}

.dt-turn-speaker {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.dt-turn-time {
  font-size: 9px;
  color: var(--text-dim, #6e7681);
}

.dt-turn-text {
  font-size: 11px;
  color: var(--text-muted, #8b949e);
  line-height: 1.6;
}

/* ── Right pane sections ─────────────────────────────────── */

.dt-section-hdr {
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--text-dim, #6e7681);
  margin-bottom: 0.25rem;
  margin-top: 0.75rem;
  padding-bottom: 0.25rem;
  border-bottom: 1px solid var(--border-muted, #21262d);
}

.dt-section-hdr:first-child {
  margin-top: 0;
}

.dt-item {
  color: var(--text-muted, #8b949e);
  margin-bottom: 0.25rem;
  line-height: 1.6;
  display: flex;
  align-items: flex-start;
  gap: 0.375rem;
}

.dt-bullet {
  display: inline-block;
  width: 4px;
  height: 4px;
  min-width: 4px;
  border-radius: 1px;
  margin-top: 0.4rem;
  background: var(--accent-primary, #5096b3);
  box-shadow: 0 0 4px rgba(80, 150, 179, 0.4);
}

.dt-decision {
  border-left: 2px solid var(--green, #2EA043);
  padding-left: 0.5rem;
  display: block;
}

.dt-insight {
  color: var(--text-dim, #6e7681);
  display: block;
}

.dt-insight-time {
  color: var(--text-dim, #6e7681);
  margin-right: 0.5rem;
  font-size: 9px;
}

.dt-kbd {
  display: inline-block;
  padding: 0.0625rem 0.375rem;
  border-radius: 3px;
  font-size: 11px;
  font-family: 'SF Mono', 'JetBrains Mono', monospace;
  background: var(--surface-2, #1c2128);
  border: 1px solid var(--border, #30363d);
  color: var(--text-muted, #8b949e);
}

/* ── Chat input (pinned to bottom of notes pane) ──────── */

.dt-chat-input {
  display: flex;
  gap: 0.375rem;
  padding: 0.5rem 0.75rem;
  border-top: 1px solid var(--border-muted, #21262d);
  background: var(--surface-1, #161b22);
  flex-shrink: 0;
}

.dt-chat-field {
  flex: 1;
  min-width: 0;
  padding: 0.375rem 0.5rem;
  font-family: 'SF Mono', 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--text, #e6edf3);
  background: var(--bg, #0d1117);
  border: 1px solid var(--border, #30363d);
  border-radius: 4px;
  outline: none;
  transition: border-color 150ms;
}

.dt-chat-field::placeholder {
  color: var(--text-dim, #6e7681);
}

.dt-chat-field:focus {
  border-color: var(--accent-primary, #5096b3);
}

.dt-chat-send {
  font-family: 'SF Mono', 'JetBrains Mono', monospace;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  padding: 0.25rem 0.625rem;
  border-radius: 4px;
  border: 1px solid rgba(80, 150, 179, 0.3);
  color: var(--accent-primary, #5096b3);
  background: rgba(80, 150, 179, 0.1);
  cursor: pointer;
  transition: background-color 150ms, opacity 150ms;
}

.dt-chat-send:hover:not(:disabled) {
  background: rgba(80, 150, 179, 0.2);
}

.dt-chat-send:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>
