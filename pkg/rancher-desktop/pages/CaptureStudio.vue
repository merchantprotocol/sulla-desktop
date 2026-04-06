<template>
  <div class="capture-studio-app">
    <div
      class="canvas"
      :class="canvasClass"
    >
      <CaptureCanvas
        :screenStream="primaryStream"
        :cameraStream="pipStream"
        :currentLayout="currentLayout"
        :primarySource="primarySource"
        :pipSource="pipSource"
        :audioOnlySources="audioOnlySources"
        ref="captureCanvasRef"
        @show-screen-menu="showScreenContextMenu"
        @show-camera-menu="showCameraContextMenu"
      />

      <TeleprompterLayout
        ref="teleprompterRef"
        :currentLayout="currentLayout"
      />

      <CameraBubble
        :cameraStream="pipStream"
        :recording="recording"
        :cameraShape="cameraShape"
        :currentLayout="currentLayout"
        :pipSource="pipSource"
        @update:cameraShape="cameraShape = $event"
        @swap="swapAssignments"
        @show-camera-menu="showCameraContextMenu"
      />

      <LayoutBar
        :currentLayout="currentLayout"
        :layouts="layouts"
        @select-layout="selectLayout"
      />

      <!-- Info badges -->
      <div class="info-badges">
        <div class="info-badge">
          <div class="dot" :class="audioDriver.speakerRunning.value ? 'green' : 'off'"></div>
          Audio driver
        </div>
        <div v-if="recording" class="info-badge">
          <div class="dot" style="background: var(--record-red); animation: blink 1s ease-in-out infinite;"></div>
          REC {{ timerDisplay }}
        </div>
        <div v-if="activeSourceCount > 0" class="info-badge">{{ activeSourceCount }} source{{ activeSourceCount !== 1 ? 's' : '' }}</div>
      </div>

      <FloatingControls
        :sources="sources"
        :builtinSources="builtinSources"
        :customSources="customSources"
        :recording="recording"
        :timerDisplay="timerDisplay"
        :prompterEnabled="prompterEnabled"
        :tracksOpen="tracksOpen"
        :currentLayout="currentLayout"
        :assign="assign"
        :iconMap="iconMap"
        @toggle-src="toggleSrc"
        @toggle-prompter="prompterEnabled = !prompterEnabled"
        @toggle-tracks="tracksOpen = !tracksOpen"
        @screenshot="doScreenshot"
        @toggle-record="toggleRecord"
        @add-source="addPopupOpen = true"
      />
    </div>

    <TrackPanel
      :sources="sources"
      :tracksOpen="tracksOpen"
      :recording="recording"
      :waveformData="waveformData"
      :colorMap="colorMap"
      :iconMap="iconMap"
      :diskDisplay="totalDiskDisplay"
      @toggle-src="toggleSrc"
      @remove-source="removeSource"
    />

    <AddSourceDialog
      :visible="addPopupOpen"
      :deviceOptions="deviceOptions"
      @close="addPopupOpen = false"
      @add-source="confirmAdd"
    />

    <ContextMenu
      :visible="ctxMenu.visible"
      :x="ctxMenu.x"
      :y="ctxMenu.y"
      :title="ctxMenu.title"
      :items="ctxMenu.items"
      @close="ctxMenu.visible = false"
    />

    <!-- Permission denied modal -->
    <div v-if="permissionDenied" class="add-popup-overlay open">
      <div class="add-popup">
        <div class="popup-header">
          <h3>Permission Required</h3>
          <button class="popup-close" @click="permissionDenied = ''">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div style="padding: 18px; font-size: 12px; color: var(--text-secondary); line-height: 1.6;">
          <p>Screen recording permission is required to capture your screen.</p>
          <p style="margin-top: 8px; color: var(--text-muted);">Open System Preferences and enable screen recording for Sulla Desktop.</p>
        </div>
        <div class="popup-actions" style="display: flex;">
          <button class="popup-btn secondary" @click="permissionDenied = ''">Cancel</button>
          <button class="popup-btn primary" @click="openSystemPreferences">Open System Preferences</button>
        </div>
      </div>
    </div>

    <!-- Disk space warning -->
    <div v-if="diskSpace.isLow.value && recording" class="info-badge" style="position: fixed; bottom: 70px; left: 50%; transform: translateX(-50%); z-index: 50; background: rgba(227, 179, 65, 0.15); border-color: var(--warning); color: var(--warning);">
      <div class="dot" style="background: var(--warning);"></div>
      Low disk space: {{ diskSpace.availableGB.value }} remaining
    </div>

    <!-- Status message toast -->
    <div v-if="statusMessage" class="status-toast">{{ statusMessage }}</div>

    <!-- Playback bar (shown after recording stops) -->
    <div v-if="lastSessionDir && !recording" class="playback-bar">
      <span class="playback-label">Session saved</span>
      <button class="playback-btn" @click="openLastSession">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        Play
      </button>
      <button class="playback-btn" @click="openSessionFolder">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        Open Folder
      </button>
      <button class="playback-btn dismiss" @click="lastSessionDir = ''">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>

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
import { useSettings } from './capture-studio/composables/useSettings';
import { useDiskSpace } from './capture-studio/composables/useDiskSpace';
import { useSpeakerCapture } from './capture-studio/composables/useSpeakerCapture';

import ContextMenu from './capture-studio/ContextMenu.vue';
import LayoutBar from './capture-studio/LayoutBar.vue';
import CameraBubble from './capture-studio/CameraBubble.vue';
import FloatingControls from './capture-studio/FloatingControls.vue';
import TrackPanel from './capture-studio/TrackPanel.vue';
import TeleprompterLayout from './capture-studio/TeleprompterLayout.vue';
import AddSourceDialog from './capture-studio/AddSourceDialog.vue';
import CaptureCanvas from './capture-studio/CaptureCanvas.vue';

const { ipcRenderer } = require('electron');
const { shell } = require('electron');

// ─── Composables ───
const audioDriver = useAudioDriver();
const mediaSources = useMediaSources();
const recorder = useRecorder();
const settings = useSettings();
const diskSpace = useDiskSpace();
const speakerCapture = useSpeakerCapture();

// Mic instances keyed by source id (created on first use, not at module level)
const micInstances = reactive<Record<string, MicInstance>>({});

// ─── State ───
const recording = ref(false);
const tracksOpen = ref(false);
const currentLayout = ref('pip');
const cameraShape = ref('circle');
const prompterEnabled = ref(false);
const flashActive = ref(false);
const addPopupOpen = ref(false);
const statusMessage = ref('');
const lastSessionDir = ref('');
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

// ─── Computed ───
const canvasClass = computed(() => {
  if (currentLayout.value === 'pip') return '';
  return 'layout-' + currentLayout.value;
});

const videoSources = computed(() => sources.filter(s => s.isVideo && s.on));

const primarySource = computed(() => sources.find(s => s.id === assign.primary && s.on) || null);
const pipSource = computed(() => sources.find(s => s.id === assign.pip && s.on) || null);

const activeSourceCount = computed(() => sources.filter(s => s.on).length);

// The stream for the primary slot — could be screen OR camera depending on assignment
const primaryStream = computed(() => {
  const src = primarySource.value;
  if (!src) return null;
  if (src.type === 'screen') return mediaSources.screenStream.value;
  if (src.type === 'camera') return mediaSources.cameraStream.value;
  return null;
});

// The stream for the PiP/secondary slot
const pipStream = computed(() => {
  const src = pipSource.value;
  if (!src) return null;
  if (src.type === 'screen') return mediaSources.screenStream.value;
  if (src.type === 'camera') return mediaSources.cameraStream.value;
  return null;
});

const totalDiskDisplay = computed(() => {
  const total = recorder.bytesWritten.value + speakerCapture.bytesWritten.value;
  if (total === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(total) / Math.log(k));
  return parseFloat((total / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
});

const audioOnlySources = computed(() => {
  return sources.filter(s => !s.isVideo && s.on).map(s => s.name).join(' + ') || 'No sources';
});

const timerDisplay = computed(() => {
  const secs = recorder.elapsedSeconds.value;
  const m = String(Math.floor(secs / 60)).padStart(2, '0');
  const s = String(secs % 60).padStart(2, '0');
  return m + ':' + s;
});

// ─── Template refs for child components ───
const teleprompterRef = ref<InstanceType<typeof TeleprompterLayout> | null>(null);
const captureCanvasRef = ref<InstanceType<typeof CaptureCanvas> | null>(null);

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
  console.log('[CaptureStudio] toggleSrc:', src.id, src.type, 'currently on:', src.on, '→', !src.on);
  src.on = !src.on;

  if (src.on) {
    try {
      if (src.type === 'screen') {
        // Check macOS permission before attempting screen capture
        const hasPermission = await checkScreenPermission();
        console.log('[CaptureStudio] Screen permission check:', hasPermission);
        if (!hasPermission) { src.on = false; return; }
        await mediaSources.acquireScreen();
        console.log('[CaptureStudio] Screen acquired, stream:', mediaSources.screenStream.value ? 'active' : 'null', 'tracks:', mediaSources.screenStream.value?.getVideoTracks().length);
      } else if (src.type === 'camera') {
        await mediaSources.acquireCamera();
        console.log('[CaptureStudio] Camera acquired, stream:', mediaSources.cameraStream.value ? 'active' : 'null', 'tracks:', mediaSources.cameraStream.value?.getVideoTracks().length);
      } else if (src.type === 'mic') {
        const mic = micInstances[src.id] || createMicInstance();
        micInstances[src.id] = mic;
        await mic.start();
      } else if (src.type === 'system') {
        await audioDriver.startCapture();
      }
    } catch (e: any) {
      console.error(`[CaptureStudio] Failed to acquire ${src.type}:`, e.message || e);
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
  console.log('[CaptureStudio] After autoAssign:', {
    layout: currentLayout.value,
    primary: assign.primary,
    pip: assign.pip,
    videoSources: videoSources.value.map(s => s.id),
    screenStream: mediaSources.screenStream.value ? 'active' : 'null',
    cameraStream: mediaSources.cameraStream.value ? 'active' : 'null',
    primaryStream: primaryStream.value ? 'active' : 'null',
  });
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
    teleprompterRef.value?.activate();
  } else {
    teleprompterRef.value?.deactivate();
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
let _stoppingFromCritical = false; // guard against infinite recursion from disk critical callback

async function toggleRecord() {
  if (!recording.value) {
    // Check disk space before starting
    const spaceCheck = diskSpace.checkBeforeRecording();
    if (!spaceCheck.ok) {
      statusMessage.value = spaceCheck.message;
      setTimeout(() => { statusMessage.value = ''; }, 5000);
      return;
    }

    // Gather active streams for recording — check stream.active not just existence
    const streams: Array<{ id: string; type: 'screen' | 'camera' | 'mic' | 'system-audio'; stream: MediaStream }> = [];

    const screenVal = mediaSources.screenStream.value;
    if (screenVal && screenVal.active) {
      streams.push({ id: 'screen', type: 'screen', stream: screenVal });
    }
    const camVal = mediaSources.cameraStream.value;
    if (camVal && camVal.active) {
      streams.push({ id: 'cam', type: 'camera', stream: camVal });
    }
    for (const [id, mic] of Object.entries(micInstances)) {
      const micStream = mic.stream.value;
      if (micStream && micStream.active && mic.active.value) {
        streams.push({ id, type: 'mic', stream: micStream });
      }
    }

    if (streams.length === 0) {
      statusMessage.value = 'Enable at least one source to record';
      setTimeout(() => { statusMessage.value = ''; }, 3000);
      return;
    }

    const sessionId = recorder.startSession(streams);

    // Start speaker capture to WAV if audio driver is running
    if (audioDriver.speakerRunning.value && sessionId) {
      const path = require('path');
      const speakerPath = path.join(recorder.getSessionDir(), 'system-audio.wav');
      await speakerCapture.start(speakerPath);
      recorder.registerExternalStream({
        id:              'sys',
        type:            'system-audio',
        filename:        'system-audio.wav',
        format:          'wav',
        getBytesWritten: () => speakerCapture.bytesWritten.value,
      });
    }

    recording.value = true;

    // Start disk space monitoring
    diskSpace.startMonitoring(() => {
      // Critical: auto-stop recording — guard against infinite recursion
      if (_stoppingFromCritical) return;
      _stoppingFromCritical = true;
      console.warn('[CaptureStudio] Critical disk space — stopping recording');
      toggleRecord().finally(() => { _stoppingFromCritical = false; });
    });
  } else {
    // Capture session dir BEFORE stopSession clears it
    const capturedSessionDir = recorder.getSessionDir();
    // Stop speaker capture
    speakerCapture.stop();
    await recorder.stopSession();
    lastSessionDir.value = capturedSessionDir;
    recording.value = false;
    diskSpace.stopMonitoring();
    statusMessage.value = 'Recording saved';
    setTimeout(() => { statusMessage.value = ''; }, 5000);
  }
}

// ─── Screenshot ───
// ─── Playback ───
function openLastSession() {
  if (!lastSessionDir.value) return;
  const fs = require('fs');
  const path = require('path');

  // Find the first video file to play
  try {
    const files = fs.readdirSync(lastSessionDir.value);
    const videoFile = files.find((f: string) => f.endsWith('.webm') && (f.startsWith('screen') || f.startsWith('camera')));
    const audioFile = files.find((f: string) => f.endsWith('.webm') || f.endsWith('.wav'));
    const fileToPlay = videoFile || audioFile;
    if (fileToPlay) {
      shell.openPath(path.join(lastSessionDir.value, fileToPlay));
    }
  } catch (e: any) {
    console.error('[CaptureStudio] Failed to open session:', e.message);
  }
}

function openSessionFolder() {
  if (!lastSessionDir.value) return;
  shell.openPath(lastSessionDir.value);
}

function doScreenshot() {
  flashActive.value = true;
  setTimeout(() => { flashActive.value = false; }, 120);
}

// ─── Add source (from dialog) ───
async function confirmAdd(payload: { type: string; deviceId: string; label: string }) {
  sourceCounter++;
  const id = 'custom_' + sourceCounter;
  const isVideo = payload.type === 'screen' || payload.type === 'camera';

  const newSrc: Source = {
    id,
    type: payload.type,
    name: payload.label,
    color: colorMap[payload.type] || 'custom',
    status: payload.type === 'screen' ? '1080p' : payload.type === 'camera' ? '720p' : '-18 dB',
    builtin: false,
    on: true,
    isVideo,
  };
  sources.push(newSrc);

  // Create mic instance for new mic sources
  if (payload.type === 'mic') {
    const mic = createMicInstance();
    micInstances[id] = mic;
    try {
      await mic.start(payload.deviceId || undefined);
    } catch (e: any) {
      console.error('[CaptureStudio] Failed to start mic for new source:', e.message);
      newSrc.on = false;
    }
  }

  if (isVideo) {
    autoAssign();
    if (currentLayout.value === 'screenonly' || currentLayout.value === 'camonly') {
      currentLayout.value = 'pip';
    }
  }

  addPopupOpen.value = false;
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
let meterAnimId: number | null = null;

watch(() => currentLayout.value, (layout) => {
  if (layout === 'audioonly') {
    startAudioMeter();
  } else {
    stopAudioMeter();
  }
});

function startAudioMeter() {
  if (meterAnimId) return;

  function tryStart() {
    const container = captureCanvasRef.value?.audioMeterVisRef;
    if (!container) {
      // Retry — DOM may not have rendered audioonly yet
      setTimeout(tryStart, 100);
      return;
    }

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

    function animateMeter() {
      if (!container || currentLayout.value !== 'audioonly') {
        meterAnimId = null;
        return;
      }
      const bars = container.children;

      // Combine all active mic levels + speaker level
      const spActive = speakerCapture && speakerCapture.active ? speakerCapture.active.value : false;
      let combinedLevel = spActive ? speakerCapture.level.value : (audioDriver.speakerLevel ? audioDriver.speakerLevel.value : 0);
      for (const mic of Object.values(micInstances)) {
        if (mic && mic.active && mic.active.value && mic.level) {
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
    meterAnimId = requestAnimationFrame(animateMeter);
  }

  nextTick(tryStart);
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

// ─── Track panel waveform (continuous animation) ───
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
        const analyserNode = mic && mic.analyser ? mic.analyser.value : null;
        if (analyserNode) {
          const data = new Uint8Array(analyserNode.frequencyBinCount);
          analyserNode.getByteFrequencyData(data);
          const binSize = Math.max(1, Math.floor(data.length / 100));
          for (let i = 0; i < 100; i++) {
            let sum = 0;
            for (let j = 0; j < binSize; j++) sum += data[i * binSize + j];
            bars.push(Math.max(2, (sum / binSize / 255) * 18));
          }
        } else {
          const lvl = (mic && mic.level) ? mic.level.value : 0;
          for (let i = 0; i < 100; i++) {
            bars.push(Math.max(2, lvl * 14 + 2));
          }
        }
      } else if (src.type === 'system') {
        const spActive = speakerCapture && speakerCapture.active ? speakerCapture.active.value : false;
        const rms = spActive ? speakerCapture.level.value : (audioDriver.speakerLevel ? audioDriver.speakerLevel.value : 0);
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

// ─── Lifecycle ───
// ─── Keyboard shortcuts ───
function onKeyDown(e: KeyboardEvent) {
  const mod = e.metaKey || e.ctrlKey;

  // Escape: close any open popup/overlay
  if (e.key === 'Escape') {
    if (addPopupOpen.value) { addPopupOpen.value = false; return; }
    if (ctxMenu.visible) { ctxMenu.visible = false; return; }
  }

  // Cmd+Shift+R: toggle recording
  if (mod && e.shiftKey && e.key.toLowerCase() === 'r') {
    e.preventDefault();
    toggleRecord();
    return;
  }

  // Cmd+S: screenshot
  if (mod && !e.shiftKey && e.key.toLowerCase() === 's') {
    e.preventDefault();
    doScreenshot();
    return;
  }

  // 1-5: switch layout (only when no input focused)
  if (!mod && !e.shiftKey && (e.target as HTMLElement).tagName !== 'INPUT' && (e.target as HTMLElement).tagName !== 'TEXTAREA') {
    const layoutKeys: Record<string, string> = { '1': 'pip', '2': 'sidebyside', '3': 'screenonly', '4': 'camonly', '5': 'teleprompter' };
    if (layoutKeys[e.key]) {
      selectLayout(layoutKeys[e.key]);
      return;
    }
  }
}

// ─── Permission check ───
const permissionDenied = ref('');

async function checkScreenPermission(): Promise<boolean> {
  try {
    const perms = await ipcRenderer.invoke('capture-studio:check-permissions');
    if (perms.screen === 'denied' || perms.screen === 'restricted') {
      permissionDenied.value = 'screen';
      return false;
    }
  } catch {}
  return true;
}

function openSystemPreferences() {
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  permissionDenied.value = '';
}

onMounted(async () => {
  document.addEventListener('keydown', onKeyDown);
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

  // Apply saved settings once loaded
  watch(() => settings.loaded.value, (loaded) => {
    if (!loaded) return;
    if (settings.layout.value) currentLayout.value = settings.layout.value;
    if (settings.cameraShape.value) cameraShape.value = settings.cameraShape.value;
  }, { immediate: true });

  // Sync settings on change
  watch(currentLayout, v => { settings.layout.value = v; });
  watch(cameraShape, v => { settings.cameraShape.value = v; });

  // Auto-start audio driver so mic + speaker levels flow immediately
  try {
    const state = await audioDriver.getState();
    if (!state.running) {
      await audioDriver.startCapture();
    }
  } catch (e) {
    console.warn('[CaptureStudio] Failed to auto-start audio driver:', e);
  }

  // Auto-enable mic on open
  const micSrc = sources.find(s => s.id === 'mic');
  if (micSrc && !micSrc.on) {
    await toggleSrc(micSrc);
  }

  // Trigger audio-only layout since no video sources are on
  autoAssign();
  if (currentLayout.value === 'audioonly') {
    startAudioMeter();
  }
});

onUnmounted(() => {
  document.removeEventListener('keydown', onKeyDown);
  stopAudioMeter();
  stopWaveformLoop();
  diskSpace.stopMonitoring();

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
.info-badge .dot.off { background: var(--text-dim); }

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

/* ═══════════════════════════════════════════════
   STATUS TOAST
   ═══════════════════════════════════════════════ */
.status-toast {
  position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%);
  padding: 8px 18px; background: var(--bg-surface); border: 1px solid var(--border);
  border-radius: 8px; font-size: 12px; color: var(--text-secondary);
  backdrop-filter: blur(8px); box-shadow: 0 4px 20px rgba(0,0,0,0.3);
  z-index: 60; animation: toast-in 0.2s ease;
}
@keyframes toast-in { from { opacity: 0; transform: translateX(-50%) translateY(10px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }

/* ═══════════════════════════════════════════════
   PLAYBACK BAR
   ═══════════════════════════════════════════════ */
.playback-bar {
  position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%);
  display: flex; align-items: center; gap: 8px; padding: 6px 12px;
  background: rgba(22,27,34,0.92); border: 1px solid var(--border); border-radius: 10px;
  backdrop-filter: blur(8px); box-shadow: 0 4px 20px rgba(0,0,0,0.3); z-index: 55;
}

.playback-label { font-size: 11px; color: var(--text-muted); margin-right: 4px; }

.playback-btn {
  display: flex; align-items: center; gap: 5px; padding: 5px 12px;
  border-radius: 6px; border: 1px solid var(--border); background: var(--bg-surface-alt);
  color: var(--text-secondary); font-family: var(--mono); font-size: 11px;
  cursor: pointer; transition: all 0.12s;
}
.playback-btn:hover { border-color: var(--accent); color: var(--text-primary); }
.playback-btn.dismiss { padding: 5px; border: none; background: none; color: var(--text-dim); }
.playback-btn.dismiss:hover { color: var(--text-primary); }

.flash-overlay {
  position: fixed; inset: 0; background: white; opacity: 0;
  pointer-events: none; z-index: 999; transition: opacity 0.05s;
}
.flash-overlay.flash { opacity: 0.15; transition: opacity 0.01s; }
</style>
