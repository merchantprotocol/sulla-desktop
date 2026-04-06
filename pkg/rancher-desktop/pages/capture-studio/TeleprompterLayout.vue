<template>
  <div class="teleprompter-layout">
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
      <button class="tp-tb-btn" @click="tpFontSize = Math.max(18, tpFontSize - 2)">-</button>
      <span class="tp-tb-val">{{ tpFontSize }}</span>
      <button class="tp-tb-btn" @click="tpFontSize = Math.min(72, tpFontSize + 2)">+</button>

      <div class="tp-tb-divider"></div>

      <span class="tp-tb-label">Speed</span>
      <input type="range" min="6" max="16" step="2" v-model.number="tpSpeed">
      <span class="tp-tb-val">{{ tpSpeed }}</span>

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

const props = defineProps<{
  currentLayout: string;
}>();

// ---- Teleprompter state ----
const tpScript = ref(`Welcome everyone to today's product demo. I'm really excited to show you what we've been building over the past few weeks. The capture studio is a new feature inside Sulla Desktop that lets you record your screen, your webcam, your microphone, and your system audio all at the same time as completely separate streams. This means you can edit each one independently later. Think of it like having a multi-camera setup but right from your laptop. The key innovation here is the teleprompter. Instead of looking off to the side to read your notes, the text appears right near your camera so you maintain eye contact with your audience. You can adjust the color of the highlighted text, change the font size, and control the scroll speed. It even supports voice-tracked scrolling where it listens to what you're saying and automatically advances the script to match your pace. Let me show you how the layout system works. You can switch between picture-in-picture mode where your camera appears as a small bubble over your screen recording, side-by-side mode for interviews or pair programming, screen-only mode when you just want to show your desktop, and camera-only mode for direct-to-camera content like this. Each video source can be toggled on and off independently. You can add new sources like a phone camera for vertical content or a second screen capture. The system automatically picks the best layout based on which sources are active. If you turn off your screen and only have your camera running it switches to full-screen camera automatically. Now let me walk you through the recording workflow. You hit the record button and all active sources start capturing simultaneously. The audio driver handles microphone and system audio capture separately so you get clean isolated tracks. During recording you can see the track lanes panel which shows waveforms for each active source. After you stop recording everything gets saved as separate files in a capture session folder with a manifest that describes all the timing relationships between the streams. From there you can hand it off to the Remotion editor for composition and export. Questions? Drop them in the chat and I'll answer them at the end.`);
const tpWords = ref<string[]>([]);
const tpCurrentIndex = ref(0);
let tpScrollInterval: ReturnType<typeof setInterval> | null = null;
const tpSpeed = ref(6);
const tpHighlightColor = ref('#e6edf3');
const tpFontSize = ref(42);
const tpScriptOpen = ref(false);
let tpPaused = false;
const voiceTracking = ref(false);

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
  if (!voiceTracking.value) {
    startTpScroll();
  }
}

function deactivate() {
  stopTpScroll();
  if (voiceTracking.value) {
    voiceTracking.value = false;
    teleprompterTracker.stopTracking();
  }
}

defineExpose({ activate, deactivate, stopTracking: () => teleprompterTracker.stopTracking() });

onMounted(() => {
  document.addEventListener('keydown', onKeyDown);
  buildTpWords();
});

onUnmounted(() => {
  document.removeEventListener('keydown', onKeyDown);
  stopTpScroll();
  teleprompterTracker.stopTracking();
});
</script>
