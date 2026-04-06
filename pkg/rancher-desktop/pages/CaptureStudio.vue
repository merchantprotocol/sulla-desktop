<template>
  <div class="capture-studio-app">
    <div
      class="canvas"
      :class="canvasClass"
    >
      <!-- Screen preview -->
      <div class="screen-preview" @contextmenu.prevent="showScreenContextMenu">
        <video
          v-if="mediaSources.screenStream.value"
          ref="screenVideoEl"
          autoplay
          muted
          style="width: 100%; height: 100%; object-fit: contain; border-radius: 12px;"
        ></video>
        <div v-else class="placeholder">
          <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
          {{ primarySource?.name || 'Screen Capture' }}
        </div>
      </div>

      <!-- Side-by-side camera (shown in sidebyside layout) -->
      <div class="sbs-camera">
        <div class="placeholder">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          {{ pipSource?.name || 'Camera' }}
        </div>
      </div>

      <!-- Full-screen camera (shown in camonly layout) -->
      <div class="fullscreen-camera">
        <div class="placeholder">
          <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          {{ primarySource?.name || 'Camera Full' }}
        </div>
      </div>

      <!-- Audio-only display -->
      <div
        class="audio-only-display"
        :class="{ visible: currentLayout === 'audioonly' }"
      >
        <div class="audio-meter-vis" ref="audioMeterVis"></div>
        <div class="audio-meter-label">
          <div class="source-name">{{ audioOnlySources }}</div>
          <div>Audio only — no video sources active</div>
        </div>
      </div>

      <!-- Teleprompter layout — immersive -->
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

      <!-- Camera bubble -->
      <div
        class="cam-container"
        ref="camContainer"
        v-show="currentLayout === 'pip' && pipSource"
        @mousedown="startDrag"
      >
        <div
          class="cam-bubble"
          :class="{ recording: recording, hidden: cameraShape === 'hidden' }"
          :style="{ borderRadius: bubbleRadius }"
          @dblclick="swapAssignments"
          @contextmenu.prevent="showCameraContextMenu"
        >
          <video
            v-if="mediaSources.cameraStream.value"
            ref="camVideoEl"
            autoplay
            muted
            style="width: 100%; height: 100%; object-fit: cover;"
          ></video>
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        </div>
        <div class="shape-picker">
          <button
            v-for="shape in shapes"
            :key="shape.id"
            class="shape-btn"
            :class="{ active: cameraShape === shape.id }"
            @click.stop="cameraShape = shape.id"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" v-html="shape.icon"></svg>
          </button>
        </div>
      </div>

      <!-- Layout bar -->
      <div class="layout-bar">
        <button
          v-for="layout in layouts"
          :key="layout.id"
          class="layout-btn"
          :class="{ active: currentLayout === layout.id }"
          @click="selectLayout(layout.id)"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" v-html="layout.icon"></svg>
          <span class="tip">{{ layout.tip }}</span>
        </button>
      </div>

      <!-- Info badges -->
      <div class="info-badges">
        <div class="info-badge"><div class="dot green"></div> Audio driver</div>
        <div class="info-badge"><div class="dot blue"></div> Transcribing</div>
        <div class="info-badge">1920x1080</div>
      </div>

      <!-- Floating controls -->
      <div class="float-controls" :class="{ 'tp-hidden': currentLayout === 'teleprompter' }">
        <!-- Default sources -->
        <button
          v-for="src in builtinSources"
          :key="src.id"
          class="src-toggle"
          :class="{ on: src.on, off: !src.on, recording: recording && src.on }"
          :title="src.name"
          @click="toggleSrc(src)"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" v-html="iconMap[src.type]"></svg>
          <div v-if="src.on" class="active-dot"></div>
          <div v-if="src.type === 'mic'" class="mic-ring"></div>
          <div v-if="src.on && src.isVideo && assign.primary === src.id" class="role-indicator primary-role">P</div>
          <div v-else-if="src.on && src.isVideo && assign.pip === src.id && (currentLayout === 'pip' || currentLayout === 'sidebyside')" class="role-indicator pip-role">2</div>
        </button>

        <!-- Custom sources -->
        <button
          v-for="src in customSources"
          :key="src.id"
          class="src-toggle custom"
          :class="{ on: src.on, off: !src.on }"
          :title="src.name"
          @click="toggleSrc(src)"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" v-html="iconMap[src.type] || iconMap.mic"></svg>
          <div v-if="src.on" class="active-dot"></div>
          <div v-if="src.on && src.isVideo && assign.primary === src.id" class="role-indicator primary-role">P</div>
          <div v-else-if="src.on && src.isVideo && assign.pip === src.id && (currentLayout === 'pip' || currentLayout === 'sidebyside')" class="role-indicator pip-role">2</div>
        </button>

        <!-- Add source -->
        <button class="add-src-btn" @click="addPopupOpen = true" title="Add source">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>

        <div class="fc-divider"></div>

        <!-- Prompter toggle -->
        <button
          class="prompter-toggle"
          :class="{ active: prompterEnabled }"
          @click="prompterEnabled = !prompterEnabled"
          title="Teleprompter"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
          <div class="active-dot"></div>
        </button>

        <!-- Track panel toggle -->
        <button
          class="track-toggle-btn"
          :class="{ active: tracksOpen }"
          @click="tracksOpen = !tracksOpen"
          title="Track lanes"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="8" cy="6" r="2" fill="currentColor"/><circle cx="16" cy="12" r="2" fill="currentColor"/><circle cx="10" cy="18" r="2" fill="currentColor"/></svg>
        </button>

        <!-- Screenshot -->
        <button class="screenshot-btn" @click="doScreenshot" title="Screenshot">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
        </button>

        <div class="fc-divider"></div>

        <span class="fc-timer" :class="{ visible: recording }">{{ timerDisplay }}</span>
        <button
          class="record-pill"
          :class="{ idle: !recording, active: recording }"
          @click="toggleRecord"
        >
          <div class="dot"></div>
          <span>{{ recording ? 'Stop' : 'Record' }}</span>
        </button>
      </div>
    </div>

    <!-- Track panel -->
    <div class="track-panel" :class="{ open: tracksOpen }">
      <div class="track-panel-header">
        Tracks
        <div class="spacer"></div>
        <span class="disk-info">Disk: {{ recorder.diskDisplay }}</span>
      </div>
      <div class="track-lanes">
        <div v-for="src in sources" :key="src.id" class="track-lane">
          <div class="track-color" :class="colorMap[src.type] || 'custom'"></div>
          <div class="track-icon" :style="{ color: src.on ? 'var(--text-muted)' : 'var(--text-dim)' }">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" v-html="iconMap[src.type] || iconMap.mic"></svg>
          </div>
          <span class="track-name" :style="{ opacity: src.on ? 1 : 0.4 }">{{ src.name }}</span>
          <div class="track-wave">
            <div class="bars">
              <div
                v-for="j in 100"
                :key="j"
                class="b"
                :style="{
                  background: waveColor(src.type),
                  height: getTrackBarHeight(src, j - 1) + 'px',
                }"
              ></div>
            </div>
            <div v-if="recording" class="playhead"></div>
          </div>
          <span class="track-status">{{ src.on ? src.status : 'off' }}</span>
          <button
            class="track-mute"
            :class="{ muted: !src.on }"
            @click="toggleSrc(src)"
          >M</button>
          <button
            v-if="!src.builtin"
            class="track-remove"
            @click="removeSource(src.id)"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      </div>
    </div>

    <!-- Add source popup -->
    <div class="add-popup-overlay" :class="{ open: addPopupOpen }">
      <div class="add-popup">
        <div class="popup-header">
          <h3>{{ addStep === 'type' ? 'Add Source' : 'Choose ' + (selectedAddType ? selectedAddType.charAt(0).toUpperCase() + selectedAddType.slice(1) : '') }}</h3>
          <button class="popup-close" @click="addPopupOpen = false">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        <!-- Step 1: type -->
        <div v-if="addStep === 'type'" class="type-grid">
          <div
            v-for="t in sourceTypes"
            :key="t.id"
            class="type-card"
            @click="selectAddType(t.id)"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" v-html="t.icon"></svg>
            <span>{{ t.label }}</span>
          </div>
        </div>

        <!-- Step 2: device -->
        <div v-if="addStep === 'device'" class="device-step visible">
          <label>{{ addDeviceLabel }}</label>
          <select class="device-select" v-model="selectedDevice">
            <option v-for="d in deviceOptions[selectedAddType] || []" :key="d" :value="d">{{ d }}</option>
          </select>
          <label>Label (optional)</label>
          <input class="device-label-input" v-model="sourceLabel" :placeholder="selectedAddType === 'system' ? 'e.g. System' : 'e.g. Guest ' + (selectedAddType || '')" />
        </div>

        <div v-if="addStep === 'device'" class="popup-actions">
          <button class="popup-btn secondary" @click="addStep = 'type'">Back</button>
          <button class="popup-btn primary" @click="confirmAdd">Add Source</button>
        </div>
      </div>
    </div>

    <!-- Context menu -->
    <div
      v-if="ctxMenu.visible"
      class="ctx-menu"
      :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
      @click="ctxMenu.visible = false"
    >
      <div class="ctx-menu-header">{{ ctxMenu.title }}</div>
      <button
        v-for="item in ctxMenu.items"
        :key="item.id"
        class="ctx-menu-item"
        :class="{ active: item.active }"
        @click="item.action()"
      >
        <img v-if="item.thumbnail" :src="item.thumbnail" class="ctx-menu-thumb" />
        {{ item.label }}
      </button>
    </div>
    <div v-if="ctxMenu.visible" class="ctx-menu-backdrop" @click="ctxMenu.visible = false"></div>

    <!-- Flash overlay -->
    <div class="flash-overlay" :class="{ flash: flashActive }"></div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { useAudioDriver } from './capture-studio/composables/useAudioDriver';
import { createMicInstance, listAudioDevices, type MicInstance } from './capture-studio/composables/useMicCapture';
import { useMediaSources } from './capture-studio/composables/useMediaSources';
import { useRecorder } from './capture-studio/composables/useRecorder';
import { useRmsWaveform, useAnalyserWaveform, levelToPercent } from './capture-studio/composables/useWaveform';
import { useTeleprompterTracking } from './capture-studio/composables/useTeleprompterTracking';

// ─── Composables ───
const audioDriver = useAudioDriver();
const mediaSources = useMediaSources();
const recorder = useRecorder();

// Mic instances keyed by source id
const micInstances = reactive<Record<string, MicInstance>>({});

// Default mic instance for the builtin mic
micInstances['mic'] = createMicInstance();

// ─── State ───
const recording = ref(false);
const seconds = ref(0);
let timerInterval: ReturnType<typeof setInterval> | null = null;
const tracksOpen = ref(false);
const currentLayout = ref('pip');
const cameraShape = ref('circle');
const prompterEnabled = ref(false);
const flashActive = ref(false);
const addPopupOpen = ref(false);
const addStep = ref<'type' | 'device'>('type');
const selectedAddType = ref<string | null>(null);
const selectedDevice = ref('');
const sourceLabel = ref('');
let sourceCounter = 0;

const assign = reactive({ primary: 'screen', pip: 'cam' });

interface Source {
  id: string;
  type: string;
  name: string;
  color: string;
  status: string;
  builtin: boolean;
  on: boolean;
  isVideo: boolean;
}

const sources = reactive<Source[]>([
  { id: 'screen', type: 'screen', name: 'Screen', color: 'screen', status: '—', builtin: true, on: false, isVideo: true },
  { id: 'cam', type: 'camera', name: 'Camera', color: 'cam', status: '—', builtin: true, on: false, isVideo: true },
  { id: 'mic', type: 'mic', name: 'Microphone', color: 'mic', status: '—', builtin: true, on: false, isVideo: false },
]);

const builtinSources = computed(() => sources.filter(s => s.builtin));
const customSources = computed(() => sources.filter(s => !s.builtin));

const colorMap: Record<string, string> = { screen: 'screen', camera: 'cam', mic: 'mic', system: 'sys' };

const iconMap: Record<string, string> = {
  screen: '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
  camera: '<path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/>',
  mic: '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/>',
  system: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>',
};

const waveColorMap: Record<string, string> = {
  screen: '#58a6ff',
  camera: '#5096b3',
  mic: '#3fb950',
  system: '#e3b341',
};

function waveColor(type: string) {
  return waveColorMap[type] || '#b392f0';
}

const deviceOptions: Record<string, string[]> = {
  screen: ['Entire Screen', 'Custom Region...', 'Screen 1 — Built-in Retina', 'Screen 2 — S27E590', 'VS Code', 'Chrome', 'Slack', 'Terminal'],
  camera: ['FaceTime HD Camera', 'Continuity Camera — iPhone', 'Logitech C920'],
  mic: ['MacBook Microphone', 'AirPods Pro', 'Blue Yeti', 'Rode NT-USB'],
  system: ['System Audio (Audio Driver)'],
};

const layouts = [
  { id: 'pip', tip: 'PiP', icon: '<rect x="2" y="2" width="20" height="20" rx="2"/><circle cx="7" cy="17" r="3"/>' },
  { id: 'sidebyside', tip: 'Side by Side', icon: '<rect x="2" y="2" width="9" height="20" rx="2"/><rect x="13" y="2" width="9" height="20" rx="2"/>' },
  { id: 'screenonly', tip: 'Screen Only', icon: '<rect x="2" y="2" width="20" height="20" rx="2"/>' },
  { id: 'camonly', tip: 'Camera Only', icon: '<circle cx="12" cy="12" r="10"/>' },
  { id: 'teleprompter', tip: 'Teleprompter', icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>' },
];

const shapes = [
  { id: 'circle', icon: '<circle cx="12" cy="12" r="10"/>' },
  { id: 'rect', icon: '<rect x="3" y="3" width="18" height="18" rx="2"/>' },
  { id: 'rounded', icon: '<rect x="3" y="3" width="18" height="18" rx="6"/>' },
  { id: 'hidden', icon: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>' },
];

const sourceTypes = [
  { id: 'screen', label: 'Screen / Window', icon: '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>' },
  { id: 'camera', label: 'Camera', icon: '<path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/>' },
  { id: 'mic', label: 'Microphone', icon: '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/>' },
  { id: 'system', label: 'System Audio', icon: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>' },
];

// ─── Computed ───
const bubbleRadius = computed(() => {
  if (cameraShape.value === 'circle') return '50%';
  if (cameraShape.value === 'rect') return '8px';
  if (cameraShape.value === 'rounded') return '24px';
  return '50%';
});

const canvasClass = computed(() => {
  if (currentLayout.value === 'pip') return '';
  return 'layout-' + currentLayout.value;
});

const videoSources = computed(() => sources.filter(s => s.isVideo && s.on));

const primarySource = computed(() => sources.find(s => s.id === assign.primary && s.on) || null);
const pipSource = computed(() => sources.find(s => s.id === assign.pip && s.on) || null);

const audioOnlySources = computed(() => {
  return sources.filter(s => !s.isVideo && s.on).map(s => s.name).join(' + ') || 'No sources';
});

const timerDisplay = computed(() => {
  const m = String(Math.floor(seconds.value / 60)).padStart(2, '0');
  const s = String(seconds.value % 60).padStart(2, '0');
  return m + ':' + s;
});

const addDeviceLabel = computed(() => {
  if (selectedAddType.value === 'screen') return 'Screen or window';
  if (selectedAddType.value === 'camera') return 'Camera device';
  if (selectedAddType.value === 'mic') return 'Microphone device';
  return 'Audio source';
});

// ─── Auto-assign: pick best layout when sources change ───
function autoAssign() {
  const vids = videoSources.value;

  if (!vids.find(s => s.id === assign.primary)) {
    assign.primary = vids[0]?.id || '';
  }

  if (!vids.find(s => s.id === assign.pip) || assign.pip === assign.primary) {
    assign.pip = vids.find(s => s.id !== assign.primary)?.id || '';
  }

  if (vids.length === 0) {
    currentLayout.value = 'audioonly';
  } else if (vids.length === 1) {
    assign.primary = vids[0].id;
    assign.pip = '';
    if (currentLayout.value === 'audioonly') {
      currentLayout.value = 'screenonly';
    }
  } else if (currentLayout.value === 'audioonly') {
    currentLayout.value = 'pip';
  } else if (currentLayout.value === 'screenonly' || currentLayout.value === 'camonly') {
    if (vids.length >= 2) currentLayout.value = 'pip';
  }
}

// ─── Source toggles (wired to real capture) ───
async function toggleSrc(src: Source) {
  src.on = !src.on;

  if (src.on) {
    try {
      if (src.type === 'screen') {
        await mediaSources.acquireScreen();
      } else if (src.type === 'camera') {
        await mediaSources.acquireCamera();
      } else if (src.type === 'mic') {
        const mic = micInstances[src.id] || createMicInstance();
        micInstances[src.id] = mic;
        await mic.start();
      } else if (src.type === 'system') {
        await audioDriver.startCapture();
      }
    } catch (e) {
      console.error(`[CaptureStudio] Failed to acquire ${src.type}:`, e);
      src.on = false; // revert toggle on failure
    }
  } else {
    if (src.type === 'screen') {
      mediaSources.releaseScreen();
    } else if (src.type === 'camera') {
      mediaSources.releaseCamera();
    } else if (src.type === 'mic') {
      micInstances[src.id]?.stop();
    } else if (src.type === 'system') {
      await audioDriver.stopCapture();
    }
  }

  autoAssign();
}

// ─── Layout selection ───
function selectLayout(layout: string) {
  const vids = videoSources.value;

  if (layout === 'camonly') {
    const cam = vids.find(s => s.type === 'camera') || vids[0];
    if (cam) assign.primary = cam.id;
  }

  if (layout === 'sidebyside' && !assign.pip) {
    assign.pip = vids.find(s => s.id !== assign.primary)?.id || '';
  }

  currentLayout.value = layout;

  if (layout === 'teleprompter') {
    buildTpWords();
    if (!voiceTracking.value) {
      startTpScroll();
    }
  } else {
    stopTpScroll();
    if (voiceTracking.value) {
      voiceTracking.value = false;
      teleprompterTracker.stopTracking();
    }
  }
}

// ─── Swap primary and pip ───
function swapAssignments() {
  if (assign.primary && assign.pip) {
    const tmp = assign.primary;
    assign.primary = assign.pip;
    assign.pip = tmp;
  }
}

// ─── Record (wired to disk writer) ───
async function toggleRecord() {
  if (!recording.value) {
    // Gather active streams for recording
    const streams: Array<{ id: string; type: 'screen' | 'camera' | 'mic' | 'system-audio'; stream: MediaStream }> = [];

    if (mediaSources.screenStream.value) {
      streams.push({ id: 'screen', type: 'screen', stream: mediaSources.screenStream.value });
    }
    if (mediaSources.cameraStream.value) {
      streams.push({ id: 'cam', type: 'camera', stream: mediaSources.cameraStream.value });
    }
    for (const [id, mic] of Object.entries(micInstances)) {
      if (mic.stream.value && mic.active.value) {
        streams.push({ id, type: 'mic', stream: mic.stream.value });
      }
    }
    // System audio comes from the screen stream's audio tracks
    if (mediaSources.screenStream.value) {
      const audioTracks = mediaSources.screenStream.value.getAudioTracks();
      if (audioTracks.length > 0) {
        const sysStream = new MediaStream(audioTracks);
        streams.push({ id: 'sys', type: 'system-audio', stream: sysStream });
      }
    }

    if (streams.length === 0) {
      console.warn('[CaptureStudio] No active streams to record');
      return;
    }

    recorder.startSession(streams);
    recording.value = true;
    seconds.value = 0;
    timerInterval = setInterval(() => { seconds.value++; }, 1000);
  } else {
    await recorder.stopSession();
    recording.value = false;
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  }
}

// ─── Screenshot ───
function doScreenshot() {
  flashActive.value = true;
  setTimeout(() => { flashActive.value = false; }, 120);
}

// ─── Add source popup ───
function selectAddType(type: string) {
  selectedAddType.value = type;
  selectedDevice.value = (deviceOptions[type] || [])[0] || '';
  sourceLabel.value = '';
  addStep.value = 'device';
}

function confirmAdd() {
  if (!selectedAddType.value) return;
  sourceCounter++;
  const device = selectedDevice.value;
  const label = sourceLabel.value || device.split(' — ')[0].split('(')[0].trim();
  const id = 'custom_' + sourceCounter;
  const isVideo = selectedAddType.value === 'screen' || selectedAddType.value === 'camera';

  const newSrc: Source = {
    id,
    type: selectedAddType.value,
    name: label,
    color: colorMap[selectedAddType.value] || 'custom',
    status: selectedAddType.value === 'screen' ? '1080p' : selectedAddType.value === 'camera' ? '720p' : '-18 dB',
    builtin: false,
    on: true,
    isVideo,
  };
  sources.push(newSrc);

  // Create mic instance for new mic sources
  if (selectedAddType.value === 'mic') {
    const mic = createMicInstance();
    micInstances[id] = mic;
    mic.start(selectedDevice.value || undefined);
  }

  if (isVideo) {
    autoAssign();
    if (currentLayout.value === 'screenonly' || currentLayout.value === 'camonly') {
      currentLayout.value = 'pip';
    }
  }

  addPopupOpen.value = false;
  addStep.value = 'type';
  selectedAddType.value = null;
}

function removeSource(id: string) {
  // Stop mic instance if exists
  if (micInstances[id]) {
    micInstances[id].stop();
    delete micInstances[id];
  }
  const idx = sources.findIndex(s => s.id === id);
  if (idx > -1) sources.splice(idx, 1);
  autoAssign();
}

// ─── Audio meter animation (real data) ───
const audioMeterVis = ref<HTMLElement | null>(null);
let meterAnimId: number | null = null;

watch(() => currentLayout.value, (layout) => {
  if (layout === 'audioonly') {
    startAudioMeter();
  } else {
    stopAudioMeter();
  }
});

function startAudioMeter() {
  nextTick(() => {
    const container = audioMeterVis.value;
    if (!container) return;
    if (container.children.length === 0) {
      const colors = ['var(--success)', 'var(--accent)', 'var(--info)', 'var(--success)'];
      for (let i = 0; i < 32; i++) {
        const bar = document.createElement('div');
        bar.className = 'meter-bar';
        bar.style.background = colors[i % colors.length];
        bar.style.height = '4px';
        container.appendChild(bar);
      }
    }
    if (meterAnimId) return;

    function animateMeter() {
      if (!container) return;
      const bars = container.children;

      // Combine all active mic levels + speaker level
      let combinedLevel = audioDriver.speakerLevel.value;
      for (const mic of Object.values(micInstances)) {
        if (mic.active.value) {
          combinedLevel = Math.max(combinedLevel, mic.level.value);
        }
      }

      for (let i = 0; i < bars.length; i++) {
        const el = bars[i] as HTMLElement;
        const center = bars.length / 2;
        const dist = Math.abs(i - center) / center;
        const base = (1 - dist) * combinedLevel * 100;
        const jitter = combinedLevel > 0.001 ? (Math.random() - 0.5) * combinedLevel * 40 : 0;
        const h = Math.max(4, base + jitter);
        el.style.height = h + 'px';
        el.style.opacity = String(0.4 + (h / 120) * 0.6);
      }
      meterAnimId = requestAnimationFrame(animateMeter);
    }
    animateMeter();
  });
}

function stopAudioMeter() {
  if (meterAnimId) {
    cancelAnimationFrame(meterAnimId);
    meterAnimId = null;
  }
}

// ─── Context menu for source switching ───
interface CtxMenuItem {
  id: string;
  label: string;
  thumbnail?: string;
  active?: boolean;
  action: () => void;
}

const ctxMenu = reactive({
  visible: false,
  x: 0,
  y: 0,
  title: '',
  items: [] as CtxMenuItem[],
});

async function showScreenContextMenu(e: MouseEvent) {
  try {
    const screenSources = await mediaSources.listScreenSources();
    ctxMenu.items = screenSources.map(s => ({
      id: s.id,
      label: s.name,
      thumbnail: s.thumbnailDataUrl,
      active: false,
      action: async () => {
        try {
          await mediaSources.switchScreen(s.id);
          // Ensure screen source is marked on
          const src = sources.find(ss => ss.id === 'screen');
          if (src) {
            src.on = true;
            src.name = s.name;
            src.status = 'Capturing';
            autoAssign();
          }
        } catch (err) {
          console.error('[CaptureStudio] Failed to switch screen:', err);
        }
      },
    }));
    ctxMenu.title = 'Switch Screen Source';
    ctxMenu.x = e.clientX;
    ctxMenu.y = e.clientY;
    ctxMenu.visible = true;
  } catch (err) {
    console.error('[CaptureStudio] Failed to list screen sources:', err);
  }
}

async function showCameraContextMenu(e: MouseEvent) {
  try {
    const cameras = await mediaSources.listVideoDevices();
    ctxMenu.items = cameras.map(cam => ({
      id: cam.deviceId,
      label: cam.label,
      active: cam.deviceId === mediaSources.activeCameraDeviceId.value,
      action: async () => {
        try {
          await mediaSources.switchCamera(cam.deviceId);
        } catch (err) {
          console.error('[CaptureStudio] Failed to switch camera:', err);
        }
      },
    }));
    ctxMenu.title = 'Switch Camera';
    ctxMenu.x = e.clientX;
    ctxMenu.y = e.clientY;
    ctxMenu.visible = true;
  } catch (err) {
    console.error('[CaptureStudio] Failed to list cameras:', err);
  }
}

// ─── Drag bubble ───
const camContainer = ref<HTMLElement | null>(null);
let dragging = false;
let dragStartX = 0;
let dragStartY = 0;
let dragOrigX = 0;
let dragOrigY = 0;

function startDrag(e: MouseEvent) {
  if ((e.target as HTMLElement).closest('.shape-btn')) return;
  const el = camContainer.value;
  if (!el) return;
  dragging = true;
  el.classList.add('dragging');
  const rect = el.getBoundingClientRect();
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  dragOrigX = rect.left;
  dragOrigY = rect.top;
  el.style.right = 'auto';
  el.style.bottom = 'auto';
  el.style.left = dragOrigX + 'px';
  el.style.top = dragOrigY + 'px';
  e.preventDefault();
}

function onMouseMove(e: MouseEvent) {
  if (!dragging) return;
  const el = camContainer.value;
  if (!el) return;
  const dx = e.clientX - dragStartX;
  const dy = e.clientY - dragStartY;
  el.style.left = (dragOrigX + dx) + 'px';
  el.style.top = (dragOrigY + dy) + 'px';
}

function onMouseUp() {
  if (!dragging) return;
  dragging = false;
  camContainer.value?.classList.remove('dragging');
}

// ─── Teleprompter ───
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

// Voice tracking composable — updates tpCurrentIndex when speech matches script
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
    if (currentLayout.value === 'teleprompter' && !tpPaused) {
      stopTpScroll();
      startTpScroll();
    }
  };
  reader.readAsText(file);
}

// ─── Voice tracking toggle ───
function toggleVoiceTracking() {
  voiceTracking.value = !voiceTracking.value;

  if (voiceTracking.value) {
    // Stop timer-based scrolling, start voice tracking
    stopTpScroll();
    teleprompterTracker.startTracking(tpWords.value, tpCurrentIndex.value);
  } else {
    // Stop voice tracking, resume timer-based scrolling
    teleprompterTracker.stopTracking();
    if (currentLayout.value === 'teleprompter') {
      startTpScroll();
    }
  }
}

// ─── Keyboard: space pause/resume, arrows navigate ───
function onKeyDown(e: KeyboardEvent) {
  if (currentLayout.value !== 'teleprompter') return;
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

// ─── Track panel waveform (continuous animation) ───
// Reactive tick counter drives re-renders. Pre-computed bar data avoids
// reading AnalyserNode during render (which doesn't trigger reactivity).
const waveformData = reactive<Record<string, number[]>>({});
let waveformAnimId: number | null = null;

function startWaveformLoop() {
  if (waveformAnimId) return;

  function tick() {
    for (const src of sources) {
      if (!src.on) {
        waveformData[src.id] = [];
        continue;
      }

      const bars: number[] = [];

      if (src.type === 'mic') {
        const mic = micInstances[src.id];
        if (mic?.analyser.value) {
          const node = mic.analyser.value;
          const data = new Uint8Array(node.frequencyBinCount);
          node.getByteFrequencyData(data);
          const binSize = Math.max(1, Math.floor(data.length / 100));
          for (let i = 0; i < 100; i++) {
            let sum = 0;
            for (let j = 0; j < binSize; j++) sum += data[i * binSize + j];
            bars.push(Math.max(2, (sum / binSize / 255) * 18));
          }
        } else {
          const lvl = mic?.level?.value || 0;
          for (let i = 0; i < 100; i++) {
            bars.push(Math.max(2, lvl * 14 + 2));
          }
        }
      } else if (src.type === 'system') {
        const rms = audioDriver.speakerLevel.value;
        for (let i = 0; i < 100; i++) {
          if (rms > 0.001) {
            const center = 50;
            const dist = Math.abs(i - center) / center;
            bars.push(Math.max(2, (1 - dist) * rms * 16 + (Math.random() - 0.5) * rms * 4));
          } else {
            bars.push(2);
          }
        }
      } else {
        // Video sources: small static indicator
        for (let i = 0; i < 100; i++) bars.push(2);
      }

      waveformData[src.id] = bars;
    }

    waveformAnimId = requestAnimationFrame(tick);
  }
  tick();
}

function stopWaveformLoop() {
  if (waveformAnimId) {
    cancelAnimationFrame(waveformAnimId);
    waveformAnimId = null;
  }
}

function getTrackBarHeight(src: Source, barIndex: number): number {
  const data = waveformData[src.id];
  if (data && data.length > barIndex) return data[barIndex];
  return 2;
}

// ─── Video element refs ───
const screenVideoEl = ref<HTMLVideoElement | null>(null);
const camVideoEl = ref<HTMLVideoElement | null>(null);

// Bind video streams to <video> elements
watch(() => mediaSources.screenStream.value, (stream) => {
  if (screenVideoEl.value) {
    screenVideoEl.value.srcObject = stream || null;
  }
});

watch(() => mediaSources.cameraStream.value, (stream) => {
  if (camVideoEl.value) {
    camVideoEl.value.srcObject = stream || null;
  }
});

// ─── Lifecycle ───
onMounted(async () => {
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
  document.addEventListener('keydown', onKeyDown);
  buildTpWords();
  startWaveformLoop();

  // Populate device dropdowns with real devices
  try {
    const { inputs } = await listAudioDevices();
    if (inputs.length > 0) {
      deviceOptions.mic = inputs.map(d => d.label);
    }
    const cameras = await mediaSources.listVideoDevices();
    if (cameras.length > 0) {
      deviceOptions.camera = cameras.map(d => d.label);
    }
  } catch (e) {
    console.warn('[CaptureStudio] Failed to enumerate devices:', e);
  }

  // Auto-enable mic on open
  const micSrc = sources.find(s => s.id === 'mic');
  if (micSrc && !micSrc.on) {
    await toggleSrc(micSrc);
  }
});

onUnmounted(() => {
  document.removeEventListener('mousemove', onMouseMove);
  document.removeEventListener('mouseup', onMouseUp);
  document.removeEventListener('keydown', onKeyDown);
  if (timerInterval) clearInterval(timerInterval);
  stopTpScroll();
  stopAudioMeter();

  // Stop waveform animation
  stopWaveformLoop();

  // Stop voice tracking
  teleprompterTracker.stopTracking();

  // Stop all mic instances
  for (const mic of Object.values(micInstances)) {
    mic.stop();
  }
});
</script>

<style>
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap');

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

html, body {
  margin: 0;
  padding: 0;
  height: 100%;
  overflow: hidden;
  background: #0d1117;
  color: #e6edf3;
  font-family: 'JetBrains Mono', 'SF Mono', monospace;
}

#app {
  height: 100%;
}

.capture-studio-app {
  --bg-page:          #0d1117;
  --bg-surface:       #161b22;
  --bg-surface-alt:   #1c2128;
  --bg-surface-hover: #21262d;
  --text-primary:     #e6edf3;
  --text-secondary:   #b1bac4;
  --text-muted:       #8b949e;
  --text-dim:         #6e7681;
  --accent:           #5096b3;
  --accent-hover:     #6ab0cc;
  --success:          #3fb950;
  --info:             #58a6ff;
  --warning:          #e3b341;
  --error:            #f85149;
  --border:           #30363d;
  --border-subtle:    #21262d;
  --mono:             'JetBrains Mono', 'SF Mono', monospace;
  --display:          'Playfair Display', serif;
  --record-red:       #e5534b;
  --record-glow:      rgba(229,83,75,0.4);

  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-page);
  color: var(--text-primary);
  font-family: var(--mono);
  font-size: 13px;
  line-height: 1.5;
  overflow: hidden;
}

/* ═══════════════════════════════════════════════
   CANVAS — full screen preview
   ═══════════════════════════════════════════════ */
.canvas {
  flex: 1;
  background: #000;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  transition: padding-bottom 0.3s;
}

.screen-preview {
  width: 88%;
  aspect-ratio: 16/9;
  max-height: 88%;
  background: var(--bg-surface);
  border-radius: 12px;
  border: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  box-shadow: 0 8px 40px rgba(0,0,0,0.4);
  transition: width 0.4s ease, height 0.4s ease, opacity 0.3s ease, transform 0.4s ease;
}

.screen-preview .placeholder { color: var(--text-dim); font-size: 13px; text-align: center; }
.screen-preview .placeholder svg { display: block; margin: 0 auto 10px; opacity: 0.2; }

.sbs-camera {
  width: 0; aspect-ratio: 16/9; max-height: 88%;
  background: var(--bg-surface); border-radius: 12px; border: 1px solid var(--border);
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 8px 40px rgba(0,0,0,0.4); overflow: hidden;
  opacity: 0; transform: scale(0.9);
  transition: width 0.4s ease, opacity 0.35s ease, transform 0.4s ease;
  pointer-events: none;
}
.sbs-camera .placeholder { color: var(--text-dim); font-size: 13px; text-align: center; }
.sbs-camera .placeholder svg { display: block; margin: 0 auto 10px; opacity: 0.2; }

.fullscreen-camera {
  width: 0; aspect-ratio: 16/9; max-height: 88%;
  background: var(--bg-surface); border-radius: 12px; border: 1px solid var(--border);
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 8px 40px rgba(0,0,0,0.4); overflow: hidden;
  opacity: 0; transform: scale(0.9);
  transition: width 0.4s ease, opacity 0.35s ease, transform 0.4s ease;
  pointer-events: none; position: absolute;
}
.fullscreen-camera .placeholder { color: var(--text-dim); font-size: 13px; text-align: center; }
.fullscreen-camera .placeholder svg { display: block; margin: 0 auto 10px; opacity: 0.2; }

/* Layout: side-by-side */
.canvas.layout-sidebyside { gap: 12px; }
.canvas.layout-sidebyside .screen-preview { width: 44%; }
.canvas.layout-sidebyside .sbs-camera { width: 44%; opacity: 1; transform: scale(1); pointer-events: auto; }
.canvas.layout-sidebyside .cam-container { opacity: 0; pointer-events: none; }

/* Layout: screen only */
.canvas.layout-screenonly .cam-container { opacity: 0; pointer-events: none; }

/* Layout: cam only */
.canvas.layout-camonly .screen-preview { width: 0; opacity: 0; }
.canvas.layout-camonly .cam-container { opacity: 0; pointer-events: none; }
.canvas.layout-camonly .fullscreen-camera { width: 70%; opacity: 1; transform: scale(1); pointer-events: auto; }

/* Layout: audio only */
.canvas.layout-audioonly .screen-preview { width: 0; opacity: 0; }
.canvas.layout-audioonly .cam-container { opacity: 0; pointer-events: none; }

/* Layout: teleprompter */
.canvas.layout-teleprompter .screen-preview { width: 0; opacity: 0; }
.canvas.layout-teleprompter .cam-container { opacity: 0; pointer-events: none; }
.canvas.layout-teleprompter .teleprompter-layout { display: flex; }

.teleprompter-layout {
  display: none; width: 100%; height: 100%; position: absolute; inset: 0;
  flex-direction: column; align-items: center; justify-content: center;
  overflow: hidden; transition: opacity 0.35s ease;
}

.tp-immersive-text {
  position: absolute; top: 60px; bottom: 70px; left: 60px; right: 60px;
  display: flex; justify-content: center; overflow: hidden;
}

.tp-preview-text {
  font-size: 42px; line-height: 1.7; text-align: center; max-width: 900px;
  font-family: var(--mono); transition: font-size 0.2s; position: relative;
  will-change: transform; padding-top: 10px;
}

.tp-preview-text .pw { display: inline; transition: opacity 0.3s, color 0.3s, font-weight 0.15s; opacity: 0.45; }
.tp-preview-text .pw.spoken { opacity: 0.15; }
.tp-preview-text .pw.current { font-weight: 700; opacity: 1; }
.tp-preview-text .pw.near { opacity: 0.7; }
.tp-preview-text .pw.upcoming { opacity: 0.45; }
.tp-preview-text .pw.far { opacity: 0.2; }

.tp-preview-text .tp-cursor {
  display: inline-block; width: 3px; height: 1em; background: var(--accent);
  margin-left: 2px; animation: tp-blink 1s ease-in-out infinite; vertical-align: text-bottom;
}
@keyframes tp-blink { 0%,100%{opacity:1} 50%{opacity:0} }

/* Floating toolbar */
.tp-float-toolbar {
  position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%);
  display: flex; align-items: center; gap: 6px; padding: 6px 10px;
  background: rgba(22,27,34,0.88); border: 1px solid var(--border); border-radius: 14px;
  backdrop-filter: blur(8px); box-shadow: 0 4px 20px rgba(0,0,0,0.3); z-index: 25;
}

.canvas.layout-teleprompter .float-controls { opacity: 0; pointer-events: none; }
.float-controls.tp-hidden { opacity: 0; pointer-events: none; }

.tp-float-toolbar .tp-tb-divider { width: 1px; height: 24px; background: var(--border); margin: 0 2px; }
.tp-float-toolbar .tp-tb-label { font-size: 10px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; margin-right: 2px; white-space: nowrap; }

.tp-swatch {
  width: 20px; height: 20px; border-radius: 50%; border: 2px solid transparent;
  cursor: pointer; transition: all 0.12s; flex-shrink: 0;
}
.tp-swatch:hover { transform: scale(1.15); }
.tp-swatch.active { border-color: white; box-shadow: 0 0 0 2px var(--accent); }

.tp-tb-btn {
  width: 30px; height: 30px; display: flex; align-items: center; justify-content: center;
  border-radius: 8px; border: none; background: none; cursor: pointer;
  color: var(--text-secondary); font-family: var(--mono); font-size: 14px; font-weight: 600;
  transition: all 0.12s;
}
.tp-tb-btn:hover { background: var(--bg-surface-hover); color: var(--text-primary); }
.tp-tb-btn.active { color: var(--accent); background: rgba(80,150,179,0.1); }

.tp-tb-val { font-size: 11px; color: var(--text-muted); min-width: 24px; text-align: center; font-variant-numeric: tabular-nums; }

.tp-float-toolbar input[type="range"] { width: 70px; height: 3px; accent-color: var(--accent); }

.tp-tb-edit-btn {
  display: flex; align-items: center; gap: 5px; padding: 5px 12px; border-radius: 8px;
  border: 1px solid var(--border); background: var(--bg-surface-alt); color: var(--text-secondary);
  font-family: var(--mono); font-size: 11px; cursor: pointer; transition: all 0.12s; white-space: nowrap;
}
.tp-tb-edit-btn:hover { border-color: var(--accent); color: var(--text-primary); }
.tp-tb-edit-btn svg { width: 14px; height: 14px; }

/* Script overlay */
.tp-script-overlay {
  position: absolute; top: 0; right: 0; width: 360px; height: 100%;
  background: rgba(22,27,34,0.92); border-left: 1px solid var(--border);
  backdrop-filter: blur(12px); display: flex; flex-direction: column; z-index: 30;
  transform: translateX(100%); transition: transform 0.3s ease;
}
.tp-script-overlay.open { transform: translateX(0); }

.tp-overlay-header {
  padding: 14px 16px; border-bottom: 1px solid var(--border-subtle); font-size: 12px;
  font-weight: 600; color: var(--text-secondary); display: flex; align-items: center;
  justify-content: space-between;
}

.tp-overlay-close {
  width: 28px; height: 28px; display: flex; align-items: center; justify-content: center;
  border: none; background: none; color: var(--text-dim); cursor: pointer; border-radius: 6px;
  transition: all 0.12s;
}
.tp-overlay-close:hover { background: var(--bg-surface-hover); color: var(--text-primary); }

.tp-overlay-body { flex: 1; padding: 16px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; }

.tp-overlay-body .tp-textarea {
  flex: 1; width: 100%; min-height: 200px; background: var(--bg-surface-alt);
  border: 1px solid var(--border); border-radius: 8px; padding: 12px;
  color: var(--text-primary); font-family: var(--mono); font-size: 12px; line-height: 1.6; resize: none;
}
.tp-overlay-body .tp-textarea:focus { outline: none; border-color: var(--accent); }
.tp-overlay-body .tp-textarea::placeholder { color: var(--text-dim); }

.tp-meta-row { display: flex; align-items: center; justify-content: space-between; font-size: 10px; color: var(--text-dim); }

.tp-file-btn {
  display: flex; align-items: center; gap: 6px; padding: 7px 12px;
  background: var(--bg-surface-alt); border: 1px solid var(--border); border-radius: 6px;
  color: var(--text-secondary); font-family: var(--mono); font-size: 11px;
  cursor: pointer; transition: all 0.12s; width: 100%; justify-content: center;
}
.tp-file-btn:hover { border-color: var(--accent); color: var(--text-primary); }
.tp-file-btn svg { width: 14px; height: 14px; }

/* ═══════════════════════════════════════════════
   CAMERA BUBBLE
   ═══════════════════════════════════════════════ */
.cam-container {
  position: absolute; bottom: 32px; left: 32px; display: flex; flex-direction: column;
  align-items: center; gap: 8px; z-index: 10; cursor: move;
  transition: opacity 0.3s ease; user-select: none;
}
.cam-container.dragging { transition: none; }
.cam-container.dragging .shape-picker { opacity: 0 !important; }

.cam-bubble {
  width: 180px; height: 180px; border-radius: 50%; background: var(--bg-surface-alt);
  border: 3px solid var(--accent); display: flex; align-items: center; justify-content: center;
  overflow: hidden; transition: all 0.3s; box-shadow: 0 8px 32px rgba(0,0,0,0.5);
}
.cam-bubble.recording { border-color: var(--record-red); box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 0 0 6px rgba(229,83,75,0.08); }
.cam-bubble.hidden { display: none; }
.cam-bubble svg { width: 36px; height: 36px; color: var(--text-dim); }

.shape-picker {
  display: flex; gap: 3px; opacity: 0; transition: opacity 0.2s;
  background: rgba(22,27,34,0.9); border: 1px solid var(--border); border-radius: 8px;
  padding: 3px; backdrop-filter: blur(8px);
}
.cam-container:hover .shape-picker { opacity: 1; }

.shape-btn {
  width: 26px; height: 26px; background: none; border: 1px solid transparent;
  border-radius: 5px; cursor: pointer; display: flex; align-items: center; justify-content: center;
  color: var(--text-dim); transition: all 0.12s;
}
.shape-btn:hover { color: var(--text-secondary); background: var(--bg-surface-hover); }
.shape-btn.active { color: var(--accent); border-color: var(--accent); background: rgba(80,150,179,0.1); }
.shape-btn svg { width: 14px; height: 14px; }

/* ═══════════════════════════════════════════════
   LAYOUT BAR
   ═══════════════════════════════════════════════ */
.layout-bar {
  position: absolute; top: 16px; left: 50%; transform: translateX(-50%);
  display: flex; gap: 3px; padding: 4px; background: rgba(22,27,34,0.88);
  border: 1px solid var(--border); border-radius: 10px; backdrop-filter: blur(8px); z-index: 10;
}
.layout-btn {
  width: 40px; height: 30px; background: none; border: 1px solid transparent;
  border-radius: 6px; cursor: pointer; display: flex; align-items: center; justify-content: center;
  color: var(--text-dim); transition: all 0.12s; position: relative;
}
.layout-btn:hover { color: var(--text-secondary); background: var(--bg-surface-hover); }
.layout-btn.active { color: var(--accent); background: rgba(80,150,179,0.1); border-color: var(--accent); }
.layout-btn svg { width: 18px; height: 18px; }
.layout-btn .tip {
  position: absolute; bottom: -26px; font-size: 10px; white-space: nowrap;
  color: var(--text-muted); background: var(--bg-surface); padding: 2px 6px;
  border-radius: 3px; border: 1px solid var(--border); opacity: 0; pointer-events: none;
  transition: opacity 0.15s;
}
.layout-btn:hover .tip { opacity: 1; }

/* ═══════════════════════════════════════════════
   INFO BADGES
   ═══════════════════════════════════════════════ */
.info-badges { position: absolute; top: 16px; right: 16px; display: flex; gap: 6px; z-index: 10; }
.info-badge {
  padding: 4px 10px; background: rgba(22,27,34,0.8); border: 1px solid var(--border);
  border-radius: 6px; font-size: 10px; color: var(--text-muted); backdrop-filter: blur(4px);
  display: flex; align-items: center; gap: 4px;
}
.info-badge .dot { width: 5px; height: 5px; border-radius: 50%; }
.info-badge .dot.green { background: var(--success); }
.info-badge .dot.blue { background: var(--info); }

/* ═══════════════════════════════════════════════
   FLOATING CONTROLS
   ═══════════════════════════════════════════════ */
.float-controls {
  position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%);
  display: flex; align-items: center; gap: 4px; padding: 5px;
  background: rgba(22,27,34,0.88); border: 1px solid var(--border); border-radius: 14px;
  backdrop-filter: blur(8px); box-shadow: 0 4px 20px rgba(0,0,0,0.3); z-index: 20;
}

.src-toggle {
  width: 36px; height: 36px; display: flex; align-items: center; justify-content: center;
  border-radius: 8px; border: none; background: none; cursor: pointer;
  transition: all 0.12s; position: relative; color: var(--text-dim);
}
.src-toggle:hover { background: var(--bg-surface-hover); color: var(--text-secondary); }
.src-toggle svg { width: 18px; height: 18px; }
.src-toggle.on { color: var(--accent); }
.src-toggle.on .active-dot {
  position: absolute; bottom: 4px; right: 4px; width: 6px; height: 6px;
  background: var(--success); border-radius: 50%; border: 1.5px solid rgba(22,27,34,0.88);
}
.src-toggle.off { opacity: 0.35; }
.src-toggle.recording { color: var(--record-red); }

.src-toggle .mic-ring {
  position: absolute; inset: 3px; border-radius: 7px; border: 2px solid transparent;
  pointer-events: none; transition: all 0.15s;
}
.src-toggle.on .mic-ring { border-bottom-color: var(--success); border-left-color: var(--success); }

.src-toggle.custom { border: 1px dashed var(--border); border-radius: 8px; }
.src-toggle.custom.on { border-style: solid; border-color: var(--accent); }

.fc-divider { width: 1px; height: 24px; background: var(--border); margin: 0 2px; }

.add-src-btn {
  width: 36px; height: 36px; display: flex; align-items: center; justify-content: center;
  border-radius: 8px; border: 1px dashed var(--border); background: none;
  color: var(--text-dim); cursor: pointer; transition: all 0.15s;
}
.add-src-btn:hover { border-color: var(--accent); color: var(--accent); background: rgba(80,150,179,0.05); }
.add-src-btn svg { width: 16px; height: 16px; }

.prompter-toggle {
  width: 36px; height: 36px; display: flex; align-items: center; justify-content: center;
  border-radius: 8px; border: none; background: none; color: var(--text-dim);
  cursor: pointer; transition: all 0.12s; position: relative;
}
.prompter-toggle:hover { background: var(--bg-surface-hover); color: var(--text-secondary); }
.prompter-toggle.active { color: var(--accent); }
.prompter-toggle svg { width: 18px; height: 18px; }

.track-toggle-btn {
  width: 36px; height: 36px; display: flex; align-items: center; justify-content: center;
  border-radius: 8px; border: none; background: none; color: var(--text-dim);
  cursor: pointer; transition: all 0.12s;
}
.track-toggle-btn:hover { background: var(--bg-surface-hover); color: var(--text-secondary); }
.track-toggle-btn.active { color: var(--accent); }
.track-toggle-btn svg { width: 18px; height: 18px; }

.fc-timer {
  font-size: 14px; font-weight: 600; color: var(--record-red); font-variant-numeric: tabular-nums;
  padding: 0 4px; min-width: 52px; text-align: center; display: none;
}
.fc-timer.visible { display: block; }

.record-pill {
  display: flex; align-items: center; gap: 8px; padding: 8px 18px; border: none;
  border-radius: 10px; font-family: var(--mono); font-size: 13px; font-weight: 600;
  cursor: pointer; transition: all 0.2s;
}
.record-pill.idle { background: var(--record-red); color: white; }
.record-pill.idle:hover { background: #d04842; box-shadow: 0 4px 20px var(--record-glow); }
.record-pill.active { background: rgba(229,83,75,0.1); border: 1px solid var(--record-red); color: var(--record-red); }
.record-pill .dot { width: 14px; height: 14px; background: currentColor; border-radius: 50%; transition: all 0.2s; }
.record-pill.active .dot { width: 12px; height: 12px; border-radius: 3px; }

.screenshot-btn {
  width: 36px; height: 36px; display: flex; align-items: center; justify-content: center;
  border-radius: 8px; border: none; background: none; color: var(--text-dim);
  cursor: pointer; transition: all 0.12s;
}
.screenshot-btn:hover { background: var(--bg-surface-hover); color: var(--text-primary); }
.screenshot-btn svg { width: 18px; height: 18px; }

/* Assignment indicator */
.src-toggle .role-indicator {
  position: absolute; top: 2px; right: 2px; font-size: 7px; font-weight: 700;
  color: var(--bg-surface); width: 12px; height: 12px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center; line-height: 1;
}
.src-toggle .role-indicator.primary-role { background: var(--accent); }
.src-toggle .role-indicator.pip-role { background: var(--success); }

/* ═══════════════════════════════════════════════
   ADD SOURCE POPUP
   ═══════════════════════════════════════════════ */
.add-popup-overlay {
  position: fixed; inset: 0; z-index: 100; display: none; align-items: center;
  justify-content: center; background: rgba(0,0,0,0.5); backdrop-filter: blur(4px);
}
.add-popup-overlay.open { display: flex; }

.add-popup {
  background: var(--bg-surface); border: 1px solid var(--border); border-radius: 14px;
  width: 360px; overflow: hidden; box-shadow: 0 16px 48px rgba(0,0,0,0.4);
}

.popup-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 18px; border-bottom: 1px solid var(--border-subtle);
}
.popup-header h3 { font-size: 14px; font-weight: 600; }

.popup-close {
  width: 28px; height: 28px; background: none; border: none; color: var(--text-dim);
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  border-radius: 6px; transition: all 0.12s;
}
.popup-close:hover { background: var(--bg-surface-hover); color: var(--text-primary); }
.popup-close svg { width: 16px; height: 16px; }

.type-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 18px; }

.type-card {
  display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 20px 12px;
  background: var(--bg-surface-alt); border: 1px solid var(--border); border-radius: 10px;
  cursor: pointer; transition: all 0.15s;
}
.type-card:hover { border-color: var(--accent); background: var(--bg-surface-hover); }
.type-card svg { width: 24px; height: 24px; color: var(--text-muted); }
.type-card span { font-size: 11px; color: var(--text-secondary); font-weight: 500; }

.device-step { display: none; padding: 18px; flex-direction: column; gap: 12px; }
.device-step.visible { display: flex; }
.device-step label { font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }

.device-select {
  width: 100%; background: var(--bg-surface-alt); border: 1px solid var(--border); border-radius: 8px;
  padding: 10px 30px 10px 12px; color: var(--text-primary); font-family: var(--mono); font-size: 12px;
  appearance: none; cursor: pointer;
  background-image: url("data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1L5 5L9 1' stroke='%238b949e' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 12px center;
}
.device-select:focus { outline: none; border-color: var(--accent); }

.device-label-input {
  width: 100%; background: var(--bg-surface-alt); border: 1px solid var(--border); border-radius: 8px;
  padding: 10px 12px; color: var(--text-primary); font-family: var(--mono); font-size: 12px;
}
.device-label-input:focus { outline: none; border-color: var(--accent); }

.popup-actions { display: flex; gap: 8px; padding: 0 18px 18px; }
.popup-btn {
  flex: 1; padding: 10px; border-radius: 8px; font-family: var(--mono); font-size: 12px;
  font-weight: 600; cursor: pointer; transition: all 0.15s; text-align: center;
}
.popup-btn.secondary { background: var(--bg-surface-alt); border: 1px solid var(--border); color: var(--text-secondary); }
.popup-btn.secondary:hover { border-color: var(--text-dim); }
.popup-btn.primary { background: var(--accent); border: 1px solid var(--accent); color: white; }
.popup-btn.primary:hover { background: var(--accent-hover); }

/* ═══════════════════════════════════════════════
   TRACK PANEL
   ═══════════════════════════════════════════════ */
.track-panel { background: var(--bg-surface); border-top: 1px solid var(--border); height: 0; overflow: hidden; transition: height 0.3s; }
.track-panel.open { height: 170px; }

.track-panel-header {
  display: flex; align-items: center; padding: 6px 12px;
  border-bottom: 1px solid var(--border-subtle); font-size: 10px; font-weight: 600;
  color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.06em;
}
.track-panel-header .spacer { flex: 1; }
.track-panel-header .disk-info { color: var(--text-dim); font-weight: 400; text-transform: none; letter-spacing: 0; }

.track-lanes { overflow-y: auto; max-height: 140px; }

.track-lane { display: flex; align-items: center; height: 32px; padding: 0 12px; gap: 8px; border-bottom: 1px solid var(--border-subtle); }
.track-lane:last-child { border-bottom: none; }

.track-color { width: 3px; height: 18px; border-radius: 2px; flex-shrink: 0; }
.track-color.screen { background: var(--info); }
.track-color.cam { background: var(--accent); }
.track-color.mic { background: var(--success); }
.track-color.sys { background: var(--warning); }
.track-color.custom { background: #b392f0; }

.track-icon { flex-shrink: 0; width: 16px; height: 16px; color: var(--text-dim); }
.track-icon svg { width: 16px; height: 16px; }

.track-name { width: 90px; font-size: 11px; color: var(--text-secondary); flex-shrink: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.track-wave { flex: 1; height: 20px; background: var(--bg-surface-alt); border-radius: 3px; position: relative; overflow: hidden; }
.track-wave .bars { display: flex; align-items: center; gap: 1px; height: 100%; padding: 2px; }
.track-wave .bars .b { flex: 1; border-radius: 1px; opacity: 0.4; min-height: 2px; }
.track-wave .playhead { position: absolute; right: 18%; top: 0; bottom: 0; width: 1.5px; background: var(--record-red); }

.track-status { width: 44px; font-size: 10px; color: var(--text-dim); text-align: right; font-variant-numeric: tabular-nums; flex-shrink: 0; }

.track-mute {
  width: 20px; height: 20px; background: none; border: 1px solid var(--border); border-radius: 4px;
  color: var(--text-dim); cursor: pointer; display: flex; align-items: center; justify-content: center;
  font-size: 9px; font-family: var(--mono); flex-shrink: 0;
}
.track-mute:hover { border-color: var(--error); color: var(--error); }
.track-mute.muted { background: rgba(248,81,73,0.1); border-color: var(--error); color: var(--error); }

.track-remove {
  width: 20px; height: 20px; background: none; border: none; color: var(--text-dim);
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  border-radius: 4px; opacity: 0; transition: opacity 0.12s;
}
.track-lane:hover .track-remove { opacity: 1; }
.track-remove:hover { color: var(--error); background: rgba(248,81,73,0.1); }
.track-remove svg { width: 12px; height: 12px; }

/* ═══════════════════════════════════════════════
   AUDIO-ONLY METER
   ═══════════════════════════════════════════════ */
.audio-only-display {
  display: none; flex-direction: column; align-items: center; gap: 20px;
  padding: 40px; opacity: 0; transition: opacity 0.4s ease;
}
.audio-only-display.visible { display: flex; opacity: 1; }

.audio-meter-vis { display: flex; align-items: flex-end; gap: 4px; height: 120px; }
.audio-meter-vis .meter-bar { width: 6px; border-radius: 3px; transition: height 0.12s ease; }

.audio-meter-label { font-size: 12px; color: var(--text-muted); text-align: center; }
.audio-meter-label .source-name { color: var(--text-secondary); font-weight: 600; }

/* ═══════════════════════════════════════════════
   ANIMATIONS
   ═══════════════════════════════════════════════ */
@keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.3} }
.rec-blink { animation: blink 1s ease-in-out infinite; }

/* ═══════════════════════════════════════════════
   CONTEXT MENU
   ═══════════════════════════════════════════════ */
.ctx-menu-backdrop {
  position: fixed; inset: 0; z-index: 199;
}

.ctx-menu {
  position: fixed; z-index: 200; min-width: 220px; max-width: 340px;
  max-height: 400px; overflow-y: auto;
  background: var(--bg-surface); border: 1px solid var(--border); border-radius: 10px;
  box-shadow: 0 12px 40px rgba(0,0,0,0.5); padding: 4px;
}

.ctx-menu-header {
  padding: 6px 10px 4px; font-size: 10px; font-weight: 600; color: var(--text-dim);
  text-transform: uppercase; letter-spacing: 0.05em;
}

.ctx-menu-item {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 6px 10px; border: none; background: none; color: var(--text-secondary);
  font-family: var(--mono); font-size: 11px; text-align: left;
  border-radius: 6px; cursor: pointer; transition: all 0.1s;
}
.ctx-menu-item:hover { background: var(--bg-surface-hover); color: var(--text-primary); }
.ctx-menu-item.active { color: var(--accent); }

.ctx-menu-thumb {
  width: 48px; height: 27px; border-radius: 3px; object-fit: cover;
  border: 1px solid var(--border); flex-shrink: 0;
}

.flash-overlay {
  position: fixed; inset: 0; background: white; opacity: 0;
  pointer-events: none; z-index: 999; transition: opacity 0.05s;
}
.flash-overlay.flash { opacity: 0.15; transition: opacity 0.01s; }
</style>
