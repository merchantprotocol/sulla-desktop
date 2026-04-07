<template>
  <div class="teleprompter-layout">
    <!-- Close button -->
    <button class="tp-close-btn" @click="$emit('close')" title="Close teleprompter">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>

    <div class="tp-immersive-text">
      <div class="tp-preview-text" ref="tpPreviewText" :style="{ fontSize: tpFontSize + 'px' }">
        <span
          v-for="(word, i) in tpWords"
          :key="i"
          class="pw"
          :class="getTpWordClass(i)"
          :style="getTpWordStyle(i)"
          @click="tpCurrentIndex = i; teleprompterTracker.setCurrentIndex(i); renderTpState()"
        >{{ word + ' ' }}</span>
      </div>
    </div>

    <!-- Floating toolbar -->
    <div class="tp-float-toolbar">
      <span class="tp-tb-label">Color</span>
      <div
        v-for="color in tpColors"
        :key="color"
        class="tp-swatch"
        :class="{ active: tpHighlightColor === color }"
        :style="{ background: color }"
        @click="tpHighlightColor = color"
      ></div>

      <div class="tp-tb-divider"></div>

      <span class="tp-tb-label">Size</span>
      <button class="tp-tb-btn" @click="tpFontSize = Math.max(8, tpFontSize - 2)">-</button>
      <span class="tp-tb-val">{{ tpFontSize }}</span>
      <button class="tp-tb-btn" @click="tpFontSize = Math.min(72, tpFontSize + 2)">+</button>

      <template v-if="!voiceTracking">
        <div class="tp-tb-divider"></div>

        <span class="tp-tb-label">Speed</span>
        <input type="range" min="6" max="16" step="2" v-model.number="tpSpeed">
        <span class="tp-tb-val">{{ tpSpeed }}</span>
      </template>

      <div class="tp-tb-divider"></div>

      <button
        class="tp-tb-btn"
        :class="{ active: voiceTracking }"
        @click="toggleVoiceTracking"
        title="Voice tracking"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/></svg>
      </button>

      <div class="tp-tb-divider"></div>

      <button
        class="tp-tb-btn"
        :class="{ active: prompterWindowOpen }"
        @click="$emit('toggle-prompter')"
        title="Floating teleprompter window"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
      </button>

      <div class="tp-tb-divider"></div>

      <button class="tp-tb-edit-btn" @click="tpScriptOpen = !tpScriptOpen">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
        Edit Script
      </button>
    </div>

    <!-- Script editor overlay -->
    <div class="tp-script-overlay" :class="{ open: tpScriptOpen }">
      <div class="tp-overlay-header">
        Edit Script
        <button class="tp-overlay-close" @click="tpScriptOpen = false">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="tp-overlay-body">
        <textarea
          class="tp-textarea"
          v-model="tpScript"
          @input="buildTpWords"
          placeholder="Type or paste your script..."
        ></textarea>
        <div class="tp-meta-row">
          <span>{{ tpWords.length }} word{{ tpWords.length !== 1 ? 's' : '' }}</span>
          <span>~{{ Math.ceil(tpWords.length / 150) }} min</span>
        </div>
        <button class="tp-file-btn" @click="($refs.tpFileInput as HTMLInputElement).click()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          Load from file
        </button>
        <input type="file" ref="tpFileInput" accept=".txt,.md" style="display:none" @change="loadTpFile">
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { useTeleprompterTracking } from './composables/useTeleprompterTracking';

const { ipcRenderer: ipc } = require('electron');

const props = defineProps<{
  currentLayout: string;
  prompterWindowOpen?: boolean;
}>();

const emit = defineEmits<{
  (e: 'toggle-prompter'): void;
  (e: 'close'): void;
}>();

// ---- Teleprompter state ----
const tpScript = ref(`Welcome to the teleprompter. Start reading this text aloud and the teleprompter will follow along with you. It listens to what you are saying and compares your words against this script. Only when it recognizes a match does it advance. That means if you pause to think the teleprompter pauses with you. If you speed up it keeps up. Go ahead and keep reading to see it in action. Notice how the current word is highlighted so you always know exactly where you are. The words you have already spoken fade behind you so they do not distract you. After a few sentences the teleprompter learns your natural reading pace and smoothly predicts where you are between updates. You do not need to stay focused on this window for tracking to work. You can switch to any layout or any app on your screen and the teleprompter keeps listening and following your voice in the background. Try clicking the floating window button in the toolbar above. That opens a small always on top window you can drag near your camera so you can maintain eye contact while reading. In that floating window you can click on any word to jump directly to it. You can also use your scroll wheel to move forward or backward through the script. This is handy if you want to go back and retake a section. Back here in the toolbar you can change the highlight color using the color swatches. Try clicking a different color and watch the current word change. You can also adjust the font size with the plus and minus buttons if the text feels too small or too large. When you are ready to use your own script click the edit button in the toolbar to open the script editor. You can type or paste your script directly or load a text file from your computer. The editor shows you a word count and an estimated read time so you can plan your recording. That is everything you need to know. Go ahead and click edit to replace this text with your own script and start recording.`);
const tpWords = ref<string[]>([]);
const tpCurrentIndex = ref(0);
let tpScrollInterval: ReturnType<typeof setInterval> | null = null;
const tpSpeed = ref(6);
const tpHighlightColor = ref('#e6edf3');
const tpFontSize = ref(42);
const tpScriptOpen = ref(false);
let tpPaused = false;
const voiceTracking = ref(true);

const teleprompterTracker = useTeleprompterTracking((index: number) => {
  tpCurrentIndex.value = index;
  renderTpState();
});

const tpColors = ['#e6edf3', '#3fb950', '#58a6ff', '#e3b341', '#f0883e', '#f85149'];

const tpPreviewText = ref<HTMLElement | null>(null);

function buildTpWords() {
  const text = tpScript.value.trim();
  tpWords.value = text ? text.split(/\s+/) : [];
  tpCurrentIndex.value = 0;
}

function getTpWordClass(i: number) {
  const idx = tpCurrentIndex.value;
  if (i < idx - 2) return 'spoken';
  if (i < idx) return 'spoken';
  if (i === idx) return 'current';
  if (i <= idx + 3) return 'near';
  if (i <= idx + 20) return 'upcoming';
  return 'far';
}

function getTpWordStyle(i: number) {
  const idx = tpCurrentIndex.value;
  if (i < idx && i >= idx - 2) return { opacity: 0.2 };
  if (i === idx) return { color: tpHighlightColor.value };
  return {};
}

function renderTpState() {
  nextTick(() => {
    const el = tpPreviewText.value;
    if (!el) return;
    const spans = el.querySelectorAll('.pw');
    const currentSpan = spans[tpCurrentIndex.value] as HTMLElement | undefined;
    if (currentSpan) {
      const container = el.parentElement;
      if (!container) return;
      const containerH = container.clientHeight;
      const targetY = 10;
      const wordTop = currentSpan.offsetTop;
      const offset = wordTop - targetY;
      const maxScroll = el.scrollHeight - containerH;
      const clampedOffset = Math.min(Math.max(0, offset), Math.max(0, maxScroll));
      el.style.transform = 'translateY(' + (-clampedOffset) + 'px)';
      el.style.transition = 'transform 0.4s ease';
    }
  });
}

function startTpScroll() {
  if (tpScrollInterval) return;
  tpPaused = false;
  const msPerWord = 1400 - (tpSpeed.value * 70);
  tpScrollInterval = setInterval(() => {
    if (tpCurrentIndex.value < tpWords.value.length - 1) {
      tpCurrentIndex.value++;
      renderTpState();
    } else {
      stopTpScroll();
    }
  }, msPerWord);
}

function stopTpScroll() {
  if (tpScrollInterval) {
    clearInterval(tpScrollInterval);
    tpScrollInterval = null;
    tpPaused = true;
  }
}

watch(tpSpeed, () => {
  if (tpScrollInterval) {
    stopTpScroll();
    startTpScroll();
  }
});

function loadTpFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    tpScript.value = (e.target?.result as string) || '';
    buildTpWords();
    if (props.currentLayout === 'teleprompter' && !tpPaused) {
      stopTpScroll();
      startTpScroll();
    }
  };
  reader.readAsText(file);
}

function toggleVoiceTracking() {
  voiceTracking.value = !voiceTracking.value;

  if (voiceTracking.value) {
    stopTpScroll();
    teleprompterTracker.startTracking(tpWords.value, tpCurrentIndex.value);
  } else {
    teleprompterTracker.stopTracking();
    if (props.currentLayout === 'teleprompter') {
      startTpScroll();
    }
  }
}

// When the floating window opens, ensure voice tracking is running so speech
// is followed regardless of which capture-studio layout is currently selected.
watch(() => props.prompterWindowOpen, (open) => {
  if (open && voiceTracking.value && !teleprompterTracker.isTracking.value) {
    if (tpWords.value.length === 0) buildTpWords();
    teleprompterTracker.startTracking(tpWords.value, tpCurrentIndex.value);
  }
});

// Keyboard: space pause/resume, arrows navigate
function onKeyDown(e: KeyboardEvent) {
  if (props.currentLayout !== 'teleprompter') return;
  if ((e.target as HTMLElement).tagName === 'TEXTAREA' || (e.target as HTMLElement).tagName === 'INPUT') return;

  if (e.code === 'Space') {
    e.preventDefault();
    if (tpScrollInterval) stopTpScroll();
    else startTpScroll();
  } else if (e.code === 'ArrowDown' || e.code === 'ArrowRight') {
    e.preventDefault();
    if (tpCurrentIndex.value < tpWords.value.length - 1) { tpCurrentIndex.value++; renderTpState(); }
  } else if (e.code === 'ArrowUp' || e.code === 'ArrowLeft') {
    e.preventDefault();
    if (tpCurrentIndex.value > 0) { tpCurrentIndex.value--; renderTpState(); }
  }
}

// Expose methods so the parent can call them when layout changes
function activate() {
  buildTpWords();
  if (voiceTracking.value) {
    teleprompterTracker.startTracking(tpWords.value, tpCurrentIndex.value);
  } else {
    startTpScroll();
  }
}

function deactivate() {
  stopTpScroll();
  // Voice tracking keeps running so the teleprompter continues
  // tracking speech even when the user switches to another layout.
  // Only the auto-scroll timer stops.
}

// Position sync is handled by the main process (teleprompterTracking.ts)
// — it broadcasts teleprompter-tracking:position to all windows including
// the floating window.  No renderer relay needed.

// Notify parent on any style change so floating window stays in sync
let onStyleUpdate: ((style: { fontSize: number; highlightColor: string }) => void) | null = null;

function setOnStyleUpdate(cb: (style: { fontSize: number; highlightColor: string }) => void) {
  onStyleUpdate = cb;
}

watch([tpFontSize, tpHighlightColor], () => {
  if (onStyleUpdate) {
    onStyleUpdate({ fontSize: tpFontSize.value, highlightColor: tpHighlightColor.value });
  }
});

// Also notify when script changes
let onScriptUpdate: ((data: { words: string[]; currentIndex: number }) => void) | null = null;

function setOnScriptUpdate(cb: (data: { words: string[]; currentIndex: number }) => void) {
  onScriptUpdate = cb;
}

watch(tpWords, () => {
  if (onScriptUpdate) {
    onScriptUpdate({ words: tpWords.value, currentIndex: tpCurrentIndex.value });
  }
  // Keep the main-process tracker in sync when the script changes mid-session
  if (teleprompterTracker.isTracking.value) {
    ipc.invoke('teleprompter-tracking:set-script', {
      words:        tpWords.value,
      currentIndex: tpCurrentIndex.value,
    }).catch(() => {});
  }
});

defineExpose({
  activate,
  deactivate,
  stopTracking: () => teleprompterTracker.stopTracking(),
  tpWords,
  tpCurrentIndex,
  tpFontSize,
  tpHighlightColor,
  setOnStyleUpdate,
  setOnScriptUpdate,
});

// Handle jump-to from the floating teleprompter window (click or scroll)
function onPrompterJumpTo(_event: any, data: { currentIndex: number }) {
  const idx = data?.currentIndex;
  if (typeof idx !== 'number' || idx < 0 || idx >= tpWords.value.length) return;
  tpCurrentIndex.value = idx;
  teleprompterTracker.setCurrentIndex(idx);
  renderTpState();
}

onMounted(() => {
  document.addEventListener('keydown', onKeyDown);
  buildTpWords();
  ipc.on('teleprompter:jump-to', onPrompterJumpTo);
});

onUnmounted(() => {
  document.removeEventListener('keydown', onKeyDown);
  ipc.removeListener('teleprompter:jump-to', onPrompterJumpTo);
  stopTpScroll();
  teleprompterTracker.stopTracking();
});
</script>
