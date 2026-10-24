/**
 * Microphone, transcription, Sulla's voice, system audio and Secretary Mode,
 * for Preferences › Voice & audio. Moved here from the old Audio Settings
 * window; it talks to the audio driver and saves through the same IPC.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

export function useVoiceSettings() {
  // The audio-driver IPC channels aren't in the typed IPC map yet.
  const ipc = ipcRenderer as any;

  // ─── TTS Providers ──────────────────────────────────────────────

  interface TtsProviderInfo {
    id:        string;
    name:      string;
    connected: boolean;
    /** Vault credential this provider needs. Absent for keyless providers (e.g. the native OS voice). */
    vaultKey?: { integrationId: string; property: string };
  }

  const ttsProviders = ref<TtsProviderInfo[]>([
    // On-device Kokoro-82M (same engine as Sulla Mobile's on-device voice) — free, private,
    // offline, no key. The default; Bella is the default voice.
    { id: 'kokoro', name: 'On-device · Kokoro (free, private)', connected: true },
    // Native macOS voices via the OS speech engine — always available, no API key. Mirrors Sulla Mobile's default.
    { id: 'system', name: 'System Default (macOS)', connected: true },
    { id: 'elevenlabs', name: 'ElevenLabs', connected: false, vaultKey: { integrationId: 'elevenlabs', property: 'api_key' } },
    // xAI Grok Text-to-Speech. Uses the metered xAI API key (Grok integration → api_key).
    { id: 'grok', name: 'Grok Voice', connected: false, vaultKey: { integrationId: 'grok', property: 'api_key' } },
  ]);

  const ttsProvider = ref('kokoro');

  // ─── Kokoro model status ────────────────────────────────────────

  interface KokoroStatus {
    phase:    'missing' | 'downloading' | 'extracting' | 'ready' | 'error';
    progress: number;
    error?:   string;
    bytes:    number;
  }
  const kokoroStatus = ref<KokoroStatus>({ phase: 'missing', progress: 0, bytes: 349_906_910 });

  function onKokoroStatus(_event: any, status: KokoroStatus) {
    kokoroStatus.value = status;
  }
  ipc.on('voice-kokoro-status-changed', onKokoroStatus);

  async function refreshKokoroStatus(): Promise<void> {
    try {
      kokoroStatus.value = await ipcRenderer.invoke('voice-kokoro-status');
    } catch { /* leave as-is */ }
  }

  async function downloadKokoro(): Promise<void> {
    ttsPreviewError.value = null;
    await ipcRenderer.invoke('voice-kokoro-download').catch(() => false);
    await refreshKokoroStatus();
  }
  const ttsVoice = ref('');
  const ttsVoiceName = ref('');
  const voices = ref<{ value: string; label: string; description?: string }[]>([]);
  const loadingVoices = ref(false);
  const previewPlaying = ref(false);
  const ttsPreviewError = ref<string | null>(null);

  function selectTtsProvider(id: string) {
    ttsProvider.value = id;
    ttsVoice.value = '';
    ttsVoiceName.value = '';
    saveSettings();
    fetchVoices();
  }

  function onVoiceChange() {
    const selected = voices.value.find(v => v.value === ttsVoice.value);
    ttsVoiceName.value = selected?.label || '';
    saveSettings();
  }

  // ─── Secretary Mode ─────────────────────────────────────────────

  const audioCaptureActive = ref(false);
  const gatewayConnected = ref(false);
  const transcriptionMode = ref('browser');

  function onCaptureState(_event: any, state: { running: boolean }) {
    if (!state) return;
    audioCaptureActive.value = state.running;
  }
  ipc.on('audio-driver:state', onCaptureState);

  // ─── Microphone & Language ──────────────────────────────────────

  const audioInputDeviceId = ref('');
  const audioInputDevices = ref<{ value: string; label: string }[]>([]);
  const loadingDevices = ref(false);
  const sttLanguage = ref('en-US');

  // STT provider — 'whisper' (local, default) or 'grok' (xAI cloud STT).
  const sttProvider = ref('whisper');
  const grokSttConnected = ref(false);

  // ─── Speaker tab ────────────────────────────────────────────────

  const speakerDeviceId = ref('');
  const speakerOutputDevices = ref<{ value: string; label: string }[]>([]);
  const loadingSpeakerDevices = ref(false);
  const speakerVolume = ref(1);   // 0.0–1.0
  const speakerMuted = ref(false);
  const speakerRms = ref(0);
  const speakerPeakVal = ref(0);  // peak hold with decay
  const PEAK_DECAY = 0.02;

  const speakerMeterPct = computed(() => Math.min(100, Math.pow(speakerRms.value, 0.5) * 100));
  const speakerVolumeDisplay = computed(() => {
    if (speakerMuted.value) return 'Muted';
    return `${ Math.round(speakerVolume.value * 100) }%`;
  });

  function onSpeakerLevelForMeter(_event: any, data: { rms: number; peak?: number }) {
    if (!data) return;
    const rms = typeof data === 'number' ? data : data.rms;
    speakerRms.value = rms;

    const pct = Math.min(100, Math.pow(rms, 0.5) * 100);
    if (pct > speakerPeakVal.value) {
      speakerPeakVal.value = pct;
    } else {
      speakerPeakVal.value = Math.max(0, speakerPeakVal.value - PEAK_DECAY * 100);
    }
  }

  function onVolumeChanged(_event: any, state: { ok: boolean; volume: number; muted: boolean } | undefined) {
    if (!state?.ok) return;
    speakerVolume.value = state.volume;
    speakerMuted.value = state.muted;
  }

  async function onSpeakerMuteToggle() {
    const result = await ipc.invoke('audio-driver:speaker-mute-toggle');
    if (result?.ok) {
      speakerVolume.value = result.volume;
      speakerMuted.value = result.muted;
    }
  }

  async function onSpeakerVolumeUp() {
    const result = await ipc.invoke('audio-driver:speaker-volume-up');
    if (result?.ok) {
      speakerVolume.value = result.volume;
      speakerMuted.value = result.muted;
    }
  }

  async function onSpeakerVolumeDown() {
    const result = await ipc.invoke('audio-driver:speaker-volume-down');
    if (result?.ok) {
      speakerVolume.value = result.volume;
      speakerMuted.value = result.muted;
    }
  }

  async function fetchSpeakerDevices() {
    if (loadingSpeakerDevices.value) return;
    loadingSpeakerDevices.value = true;
    try {
      // Do not request microphone permission from the System Audio tab. Output
      // labels may be generic until macOS has granted media access, but this
      // screen should never send the user into the Microphone approval flow.
      if (!navigator.mediaDevices?.enumerateDevices) {
        speakerOutputDevices.value = [];
        return;
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      const hiddenDevices = ['blackhole', 'sulla audio mirror', 'audio driver mirror'];
      speakerOutputDevices.value = devices
        .filter(d => d.kind === 'audiooutput')
        .filter(d => d.deviceId && d.deviceId !== 'default')
        .filter(d => !hiddenDevices.some(h => (d.label || '').toLowerCase().includes(h)))
        .map((d, i) => ({
          value: d.deviceId,
          label: d.label || `Speaker ${ i + 1 }`,
        }));
    } catch (err) {
      console.warn('[AudioSettings] Failed to enumerate output devices:', err);
      speakerOutputDevices.value = [];
    } finally {
      loadingSpeakerDevices.value = false;
    }
  }

  async function onSpeakerDeviceChange() {
    const selected = speakerOutputDevices.value.find(d => d.value === speakerDeviceId.value);
    if (selected) {
      await ipc.invoke('audio-driver:set-system-output', selected.label);
    }
  }

  async function fetchSpeakerVolume() {
    try {
      const result = await ipc.invoke('audio-driver:speaker-volume-get');
      if (result?.ok) {
        speakerVolume.value = result.volume;
        speakerMuted.value = result.muted;
      }
    } catch { /* ignore */ }
  }

  ipc.on('audio-driver:speaker-level', onSpeakerLevelForMeter);
  ipc.on('audio-driver:volume-changed', onVolumeChanged);

  // ─── Permissions & install status ────────────────────────────────

  const micPermission = ref<string>('unknown'); // 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'
  const micPermissionChecking = ref(false);
  const micError = ref<string | null>(null);
  const loopbackInstalled = ref<boolean | null>(null); // null = not checked yet
  const loopbackName = ref<string | null>(null);
  const loopbackInstalling = ref(false);
  const loopbackError = ref<string | null>(null);

  async function checkMicPermission() {
    micPermissionChecking.value = true;
    try {
      const result = await ipc.invoke('audio-driver:check-permissions');
      micPermission.value = result?.microphone || 'unknown';
    } catch (e: any) {
      console.error('[AudioSettings] checkMicPermission error:', e);
    } finally {
      micPermissionChecking.value = false;
    }
  }

  async function requestMicPermission() {
    micPermissionChecking.value = true;
    micError.value = null;
    try {
      const result = await ipc.invoke('audio-driver:request-mic-permission');
      if (result?.granted) {
        micPermission.value = 'granted';
      } else {
        micPermission.value = result?.status || 'denied';
        if (result?.openSettings) {
          micError.value = 'Microphone access was denied. Open System Settings > Privacy & Security > Microphone to grant access.';
        }
      }
    } catch (e: any) {
      console.error('[AudioSettings] requestMicPermission error:', e);
    } finally {
      micPermissionChecking.value = false;
    }
  }

  async function checkLoopbackStatus() {
    try {
      const result = await ipc.invoke('audio-driver:check-loopback');
      loopbackInstalled.value = result?.installed ?? false;
      loopbackName.value = result?.name || null;
    } catch (e: any) {
      console.error('[AudioSettings] checkLoopbackStatus error:', e);
    }
  }

  async function installLoopback() {
    loopbackInstalling.value = true;
    loopbackError.value = null;
    try {
      const result = await ipc.invoke('audio-driver:install-loopback');
      if (result?.ok) {
        loopbackInstalled.value = true;
        loopbackName.value = result?.name || null;
      } else {
        loopbackError.value = result?.error || 'Installation failed';
      }
    } catch (e: any) {
      loopbackError.value = e.message || 'Installation failed';
      console.error('[AudioSettings] installLoopback error:', e);
    } finally {
      loopbackInstalling.value = false;
    }
  }

  // Listen for mic errors from the renderer (e.g. getUserMedia denied)
  function onMicError(_event: any, data: any) {
    console.error('[AudioSettings] mic-error:', data);
    micError.value = data?.error === 'microphone-permission-denied'
      ? 'Microphone permission denied. Open System Settings > Privacy & Security > Microphone to grant access.'
      : `Microphone error: ${ data?.message || data?.error || 'unknown' }`;
    micRunning.value = false;
  }
  ipc.on('audio-driver:mic-error', onMicError);

  // ─── Audio Driver pipeline ──────────────────────────────────────

  const micRunning = ref(false);
  const speakerRunning = ref(false);
  const driverMicLevel = ref(0);
  const driverSpeakerLevel = ref(0);
  const vadSpeaking = ref(false);
  const vadFanNoise = ref(false);
  const vadNoiseFloor = ref(0);
  const vadZcr = ref('0.000');
  const vadVariance = ref('0.000000');
  const vadPitch = ref('--');
  const vadCentroid = ref('0.0000');

  const driverMicDb = computed(() => {
    if (driverMicLevel.value <= 0) return '-inf';
    const db = 20 * Math.log10(driverMicLevel.value);
    return db > -100 ? db.toFixed(0) : '-inf';
  });


  const vadNoiseFloorDb = computed(() => {
    if (vadNoiseFloor.value <= 0) return '-inf';
    const db = 20 * Math.log10(vadNoiseFloor.value);
    return db > -100 ? db.toFixed(1) : '-inf';
  });

  let vadFrameCount = 0;
  function onMicVad(_event: any, data: { speaking: boolean; level: number; fanNoise: boolean; noiseFloor?: number; zcr?: number; variance?: number; pitch?: number | null; centroid?: number }) {
    if (!data) return;
    vadFrameCount++;
    if (vadFrameCount <= 5 || vadFrameCount % 300 === 0) {
      console.log('[AudioSettings] onMicVad frame', { frame: vadFrameCount, speaking: data.speaking, level: data.level?.toFixed(3) });
    }
    driverMicLevel.value = data.level;
    vadSpeaking.value = data.speaking;
    vadFanNoise.value = data.fanNoise;
    if (data.noiseFloor !== undefined) vadNoiseFloor.value = data.noiseFloor;
    if (data.zcr !== undefined) vadZcr.value = data.zcr.toFixed(3);
    if (data.variance !== undefined) vadVariance.value = data.variance.toFixed(6);
    if (data.pitch !== undefined) vadPitch.value = data.pitch !== null ? `${ data.pitch.toFixed(0) } Hz` : '--';
    if (data.centroid !== undefined) vadCentroid.value = data.centroid.toFixed(4);

    // Feed scrolling waveform
    pushWaveformSample(data.level, data.speaking);
  }

  // ─── Scrolling waveform ──────────────────────────────────────────

  const micWaveformCanvas = ref<HTMLCanvasElement | null>(null);
  const whisperWaveformCanvas = ref<HTMLCanvasElement | null>(null);

  const WAVEFORM_HISTORY = 300; // ~5 seconds at 60fps
  const waveformSamples: { level: number; speaking: boolean }[] = [];

  function pushWaveformSample(level: number, speaking: boolean) {
    waveformSamples.push({ level, speaking });
    if (waveformSamples.length > WAVEFORM_HISTORY) {
      waveformSamples.shift();
    }
    drawWaveform(micWaveformCanvas.value);
    drawWaveform(whisperWaveformCanvas.value);
  }

  function drawWaveform(canvas: HTMLCanvasElement | null) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Match canvas pixel size to layout size
    const rect = canvas.getBoundingClientRect();
    if (canvas.width !== rect.width) canvas.width = rect.width;
    if (canvas.height !== rect.height) canvas.height = rect.height;

    const w = canvas.width;
    const h = canvas.height;
    const midY = h / 2;
    const samples = waveformSamples;
    const len = samples.length;

    // Clear
    ctx.clearRect(0, 0, w, h);

    // Center line
    ctx.strokeStyle = 'rgba(128, 128, 128, 0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(w, midY);
    ctx.stroke();

    if (len < 2) return;

    // Draw waveform bars (like a DAW track)
    const barWidth = w / WAVEFORM_HISTORY;
    const startX = w - (len * barWidth);

    for (let i = 0; i < len; i++) {
      const s = samples[i];
      const x = startX + (i * barWidth);
      // Map level (0-1) to amplitude. Use sqrt for better visual dynamic range
      const amp = Math.sqrt(s.level) * midY * 0.9;

      if (s.speaking) {
        ctx.fillStyle = 'rgba(52, 211, 153, 0.8)'; // green when speaking
      } else if (s.level > 0.01) {
        ctx.fillStyle = 'rgba(148, 163, 184, 0.5)'; // gray for ambient noise
      } else {
        ctx.fillStyle = 'rgba(148, 163, 184, 0.15)'; // dim for silence
      }

      // Draw mirrored bar (top and bottom from center)
      const barW = Math.max(1, barWidth - 0.5);
      ctx.fillRect(x, midY - amp, barW, amp * 2);
    }
  }

  function onSpeakerLevel(_event: any, data: { rms: number }) {
    if (!data) return;
    driverSpeakerLevel.value = typeof data === 'number' ? data : data.rms;
  }

  function onDriverState(_event: any, state: { running: boolean; micRunning?: boolean; speakerRunning?: boolean } | undefined) {
    if (!state) return;
    // Support both old (single `running`) and new (split) state shapes
    micRunning.value = state.micRunning ?? state.running;
    speakerRunning.value = state.speakerRunning ?? false;
    if (!state.running) {
      driverMicLevel.value = 0;
      driverSpeakerLevel.value = 0;
      vadSpeaking.value = false;
      vadFanNoise.value = false;
      vadNoiseFloor.value = 0;
    }
  }

  async function toggleMicDriver() {
    micError.value = null;
    if (micRunning.value) {
      // Stop any active recording first
      if (micTestRecording.value) {
        await stopMicTestRecording();
      }
      await ipc.invoke('audio-driver:stop-mic', 'audio-settings-test');
      micRunning.value = false;
    } else {
      // Request both PCM formats so raw + gated are both available
      const result = await ipc.invoke('audio-driver:start-mic', 'audio-settings-test', ['pcm-s16le', 'pcm-s16le-raw']);
      if (result?.ok === false && result?.error === 'microphone-permission-denied') {
        micPermission.value = 'denied';
        micError.value = 'Microphone permission denied. Open System Settings > Privacy & Security > Microphone to grant access.';
        return;
      }
      micRunning.value = true;
    }
  }

  // ─── Mic test recording ─────────────────────────────────────────

  const MIC_TEST_MODES = {
    raw:                'Studio Quality — Raw (ASMR)',
    'noise-reduction':  'Studio Quality — Voice (Noise Reduction)',
    'voice-compressed': 'Studio Quality — Voice + Compression',
    streaming:          'Compressed — Streaming',
    'streaming-voice':  'Compressed — Voice (Streaming)',
  } as const;

  type MicTestModeKey = keyof typeof MIC_TEST_MODES;

  const micTestMode = ref<MicTestModeKey>('raw');
  const micTestRecording = ref(false);
  const micTestDuration = ref('0:00');
  const micTestAudioUrl = ref<string | null>(null);
  const micTestModeLabel = ref('');
  let micTestTimer: ReturnType<typeof setInterval> | null = null;
  let micTestSeconds = 0;

  /** Map UI mode to the controller recording mode */
  function getRecordingMode(mode: MicTestModeKey): string {
    switch (mode) {
    case 'raw': return 'raw';
    case 'noise-reduction': return 'noise-reduction';
    case 'voice-compressed': return 'noise-reduction'; // same PCM path, compression applied later
    case 'streaming': return 'raw';             // TODO: WebM/Opus path
    case 'streaming-voice': return 'noise-reduction'; // TODO: WebM/Opus + noise reduction
    default: return 'raw';
    }
  }

  async function startMicTestRecording() {
    // Clear previous
    if (micTestAudioUrl.value) { URL.revokeObjectURL(micTestAudioUrl.value); micTestAudioUrl.value = null }

    const mode = getRecordingMode(micTestMode.value);
    micTestModeLabel.value = MIC_TEST_MODES[micTestMode.value];
    console.log('[AudioSettings] Starting test recording', { uiMode: micTestMode.value, recordMode: mode });
    await ipc.invoke('audio-driver:test-record-start', mode);
    micTestRecording.value = true;
    micTestSeconds = 0;
    micTestDuration.value = '0:00';
    micTestTimer = setInterval(() => {
      micTestSeconds++;
      const m = Math.floor(micTestSeconds / 60);
      const s = micTestSeconds % 60;
      micTestDuration.value = `${ m }:${ s.toString().padStart(2, '0') }`;
    }, 1000);
  }

  async function stopMicTestRecording() {
    if (micTestTimer) { clearInterval(micTestTimer); micTestTimer = null }
    micTestRecording.value = false;

    console.log('[AudioSettings] Stopping test recording');
    const result = await ipc.invoke('audio-driver:test-record-stop');
    console.log('[AudioSettings] test-record-stop result', { hasRaw: !!result?.raw, hasReduced: !!result?.noiseReduced });

    // Pick the right audio based on mode
    const audioData = result?.noiseReduced || result?.raw;
    if (audioData) {
      const blob = new Blob([audioData], { type: 'audio/wav' });
      micTestAudioUrl.value = URL.createObjectURL(blob);
    }
  }

  function toggleMicTestRecording() {
    if (micTestRecording.value) {
      stopMicTestRecording();
    } else {
      startMicTestRecording();
    }
  }

  const speakerTransitioning = ref(false);

  async function toggleSpeakerDriver() {
    if (speakerTransitioning.value) return; // prevent double-click
    speakerTransitioning.value = true;
    try {
      if (speakerRunning.value) {
        // Don't await — deactivate can take 5-15s (Swift compilation).
        // Update UI immediately so the user isn't stuck.
        speakerRunning.value = false;
        ipc.invoke('audio-driver:stop-speaker', 'audio-settings-test').catch((e: any) => {
          console.warn('[AudioSettings] stop-speaker error:', e);
        });
        // Give the IPC a moment to dispatch, then clear transitioning
        setTimeout(() => { speakerTransitioning.value = false }, 500);
      } else {
        await ipc.invoke('audio-driver:start-speaker', 'audio-settings-test');
        speakerRunning.value = true;
        speakerTransitioning.value = false;
      }
    } catch (e: any) {
      console.error('[AudioSettings] toggleSpeakerDriver error:', e);
      speakerTransitioning.value = false;
    }
  }

  // Register driver IPC listeners immediately (settings page should always reflect driver state)
  ipc.on('audio-driver:mic-vad', onMicVad);
  ipc.on('audio-driver:speaker-level', onSpeakerLevel);
  ipc.on('audio-driver:state', onDriverState);

  // ─── Whisper.cpp (local transcription) ─────────────────────────

  // ── State ──

  const whisperInstalled = ref(false);
  const whisperVersion = ref('');
  const whisperBinaryPath = ref('');
  const whisperModels = ref<string[]>([]);
  const whisperDetecting = ref(false);
  const whisperDownloading = ref(false);
  const whisperModelToDownload = ref('base.en');
  const whisperTranscribing = ref(false);
  const whisperTranscribeMode = ref('conversation');
  const activeWhisperModel = ref('');

  // ── Model catalog ──

  const WHISPER_MODEL_CATALOG: { id: string; size: string; speed: string; lang: string }[] = [
    { id: 'tiny.en', size: '75 MB', speed: 'fastest', lang: 'English only' },
    { id: 'tiny', size: '75 MB', speed: 'fastest', lang: 'multilingual' },
    { id: 'base.en', size: '141 MB', speed: 'fast', lang: 'English only' },
    { id: 'base', size: '141 MB', speed: 'fast', lang: 'multilingual' },
    { id: 'small.en', size: '466 MB', speed: 'balanced', lang: 'English only' },
    { id: 'small', size: '466 MB', speed: 'balanced', lang: 'multilingual' },
    { id: 'medium.en', size: '1.5 GB', speed: 'accurate', lang: 'English only' },
    { id: 'medium', size: '1.5 GB', speed: 'accurate', lang: 'multilingual' },
    { id: 'large', size: '2.9 GB', speed: 'most accurate', lang: 'multilingual' },
  ];

  const availableWhisperModels = computed(() => {
    const available = WHISPER_MODEL_CATALOG.filter(m => !whisperModels.value.includes(m.id));
    // Auto-select first available if current selection is already downloaded
    if (available.length > 0 && !available.find(m => m.id === whisperModelToDownload.value)) {
      whisperModelToDownload.value = available[0].id;
    }
    return available;
  });

  function getModelMeta(modelId: string): string {
    const m = WHISPER_MODEL_CATALOG.find(c => c.id === modelId);
    return m ? `${ m.size } · ${ m.speed } · ${ m.lang }` : '';
  }

  function setActiveWhisperModel(model: string) {
    activeWhisperModel.value = model;
    ipc.invoke('sulla-settings-set', 'audioWhisperModel', model);
  }

  // ── Transcribe pipeline stats (polled while transcribing) ──
  const transcribeStats = ref<{ active: boolean; transcribing: boolean; micBytesReceived: number; micChunksReceived: number } | null>(null);
  let transcribeStatsPollTimer: ReturnType<typeof setInterval> | null = null;

  function startTranscribeStatsPoll() {
    transcribeStats.value = null;
    transcribeStatsPollTimer = setInterval(async() => {
      try {
        transcribeStats.value = await ipc.invoke('audio-driver:transcribe-status');
      } catch { /* ignore */ }
    }, 500);
  }

  function stopTranscribeStatsPoll() {
    if (transcribeStatsPollTimer) {
      clearInterval(transcribeStatsPollTimer);
      transcribeStatsPollTimer = null;
    }
    transcribeStats.value = null;
  }

  // ── Progress tracking ──

  const whisperProgressPhase = ref('');
  const whisperProgressPct = ref(-1);
  const whisperLogLines = ref<string[]>([]);
  const whisperBusy = computed(() => whisperDownloading.value || whisperDetecting.value);

  function addWhisperLog(line: string) {
    whisperLogLines.value.push(line);
    // Keep last 50 lines
    if (whisperLogLines.value.length > 50) {
      whisperLogLines.value.splice(0, whisperLogLines.value.length - 50);
    }
  }

  function clearWhisperLog() {
    whisperLogLines.value = [];
    whisperProgressPhase.value = '';
    whisperProgressPct.value = -1;
  }

  // ── Actions ──

  async function detectWhisper() {
    whisperDetecting.value = true;
    try {
      const status = await ipc.invoke('audio-driver:whisper-detect');
      whisperInstalled.value = !!status?.available;
      whisperVersion.value = status?.version || '';
      whisperBinaryPath.value = status?.binaryPath || '';
      whisperModels.value = status?.models || [];
      // Auto-select first model if none is active or active model was deleted
      if (whisperModels.value.length > 0 && (!activeWhisperModel.value || !whisperModels.value.includes(activeWhisperModel.value))) {
        setActiveWhisperModel(whisperModels.value[0]);
      }
    } catch (e: any) {
      console.warn('[AudioSettings] whisper detect failed:', e);
    } finally {
      whisperDetecting.value = false;
    }
  }

  async function downloadWhisperModel() {
    whisperDownloading.value = true;
    clearWhisperLog();
    whisperProgressPhase.value = `Downloading ${ whisperModelToDownload.value }`;
    whisperProgressPct.value = 0;
    addWhisperLog(`Downloading model: ${ whisperModelToDownload.value }...`);
    try {
      const result = await ipc.invoke('audio-driver:whisper-download-model', whisperModelToDownload.value);
      if (result?.ok) {
        addWhisperLog('Download complete.');
        await detectWhisper();
      } else {
        addWhisperLog('Download failed.');
      }
    } catch (e: any) {
      addWhisperLog(`Error: ${ e.message }`);
    } finally {
      whisperDownloading.value = false;
    }
  }

  async function deleteWhisperModel(model: string) {
    if (!confirm(`Delete model "${ model }"? You can re-download it later.`)) return;
    addWhisperLog(`Deleting model: ${ model }...`);
    try {
      const fs = require('fs') as typeof import('fs');
      const path = require('path') as typeof import('path');
      const modelsDir = `${ process.env.HOME }/.sulla/cache/whisper/models`;
      const modelFile = path.join(modelsDir, `ggml-${ model }.bin`);
      fs.unlinkSync(modelFile);
      addWhisperLog(`Deleted ${ model }.`);
      // If we deleted the active model, clear it (detectWhisper will auto-select another)
      if (activeWhisperModel.value === model) {
        activeWhisperModel.value = '';
      }
      await detectWhisper();
    } catch (e: any) {
      addWhisperLog(`Failed to delete: ${ e.message }`);
    }
  }

  interface WhisperTestEntry {
    speaker: string;
    text:    string;
    partial: boolean;
  }

  const whisperTestEntries = ref<WhisperTestEntry[]>([]);

  /**
   * Toggle whisper test — starts mic + whisper, shows transcript output.
   * Stops both when done.
   */
  async function toggleWhisperTest() {
    console.log('[AudioSettings] toggleWhisperTest', { current: whisperTranscribing.value });
    if (whisperTranscribing.value) {
      // Stop whisper + mic
      console.log('[AudioSettings] Stopping whisper transcription...');
      await ipc.invoke('audio-driver:transcribe-stop');
      console.log('[AudioSettings] Stopping mic (whisper-test)...');
      await ipc.invoke('audio-driver:stop-mic', 'whisper-test');
      whisperTranscribing.value = false;
      micRunning.value = false;
      stopTranscribeStatsPoll();
      console.log('[AudioSettings] Whisper test stopped');
    } else {
      // Clear previous results
      whisperTestEntries.value = [];
      // Start mic first, then whisper
      console.log('[AudioSettings] Starting mic (whisper-test)...');
      const micResult = await ipc.invoke('audio-driver:start-mic', 'whisper-test', ['pcm-s16le']);
      console.log('[AudioSettings] start-mic result:', micResult);
      micRunning.value = true;
      console.log('[AudioSettings] Starting whisper transcription...', { mode: whisperTranscribeMode.value });
      const result = await ipc.invoke('audio-driver:transcribe-start', {
        mode:  whisperTranscribeMode.value,
        model: activeWhisperModel.value || undefined,
      });
      console.log('[AudioSettings] transcribe-start result:', result);
      whisperTranscribing.value = !!result?.ok;
      if (result?.ok) {
        startTranscribeStatsPoll();
      } else {
        console.error('[AudioSettings] Whisper transcription failed to start');
      }
    }
  }

  // Capture whisper transcript events into the test area
  function onWhisperTestTranscript(_event: any, msg: any) {
    if (!msg?.text || !whisperTranscribing.value) return;

    const speaker = msg.channel_label || msg.speaker || 'You';
    const isPartial = msg.event_type === 'transcript_partial';
    const last = whisperTestEntries.value[whisperTestEntries.value.length - 1];

    if (isPartial) {
      if (last?.partial) {
        last.text = msg.text;
      } else {
        whisperTestEntries.value.push({ speaker, text: msg.text, partial: true });
      }
    } else {
      if (last?.partial) {
        last.text = msg.text;
        last.partial = false;
      } else {
        whisperTestEntries.value.push({ speaker, text: msg.text, partial: false });
      }
    }

    if (whisperTestEntries.value.length > 50) {
      whisperTestEntries.value.splice(0, whisperTestEntries.value.length - 50);
    }
  }

  ipc.on('gateway-transcript', onWhisperTestTranscript);

  // ── IPC listeners ──

  // Status updates (after install/remove/model download completes)
  function onWhisperStatus(_event: any, status: any) {
    if (!status) return;
    whisperInstalled.value = !!status.available;
    whisperVersion.value = status.version || '';
    whisperBinaryPath.value = status.binaryPath || '';
    whisperModels.value = status.models || [];
  }
  ipc.on('audio-driver:whisper-status', onWhisperStatus);

  // Progress updates (streaming from brew/curl)
  function onWhisperProgress(_event: any, data: any) {
    if (!data) return;
    if (data.status) {
      whisperProgressPhase.value = data.phase === 'install'
        ? 'Installing whisper.cpp'
        : data.phase === 'uninstall'
          ? 'Uninstalling whisper.cpp'
          : data.phase === 'download'
            ? `Downloading ${ data.model || 'model' }`
            : data.status;
      addWhisperLog(data.status);
    }
    if (typeof data.pct === 'number' && data.pct >= 0) {
      whisperProgressPct.value = data.pct;
    }
    if (data.pct === 100) {
      // Auto-clear progress after completion
      setTimeout(clearWhisperLog, 3000);
    }
  }
  ipc.on('audio-driver:whisper-progress', onWhisperProgress);

  function onMicDeviceChange() {
    saveSettings();
  }

  function onSttProviderChange() {
    saveSettings();
    checkGrokSttConnection();
  }

  // Grok STT uses the same metered xAI api_key as Grok TTS (OAuth tokens are rejected by api.x.ai).
  async function checkGrokSttConnection(): Promise<void> {
    try {
      const result = await ipcRenderer.invoke('integration-get-value', 'grok', 'api_key');
      grokSttConnected.value = !!(result?.value);
    } catch {
      grokSttConnected.value = false;
    }
  }

  // ─── Settings persistence ───────────────────────────────────────

  async function loadSettings(): Promise<void> {
    try {
      ttsProvider.value = await ipcRenderer.invoke('sulla-settings-get', 'audioTtsProvider', 'kokoro');
      ttsVoice.value = await ipcRenderer.invoke('sulla-settings-get', 'audioTtsVoice', '');
      ttsVoiceName.value = await ipcRenderer.invoke('sulla-settings-get', 'audioTtsVoiceName', '');
      transcriptionMode.value = await ipcRenderer.invoke('sulla-settings-get', 'audioTranscriptionMode', 'browser');
      sttLanguage.value = await ipcRenderer.invoke('sulla-settings-get', 'audioSttLanguage', 'en-US');
      sttProvider.value = await ipcRenderer.invoke('sulla-settings-get', 'audioSttProvider', 'whisper');
      audioInputDeviceId.value = await ipcRenderer.invoke('sulla-settings-get', 'audioInputDeviceId', '');
      activeWhisperModel.value = await ipcRenderer.invoke('sulla-settings-get', 'audioWhisperModel', '');
    } catch (err) {
      console.error('[AudioSettings] Failed to load settings:', err);
    }
  }

  async function saveSettings(): Promise<void> {
    try {
      await ipcRenderer.invoke('sulla-settings-set', 'audioTtsProvider', ttsProvider.value);
      await ipcRenderer.invoke('sulla-settings-set', 'audioTtsVoice', ttsVoice.value);
      await ipcRenderer.invoke('sulla-settings-set', 'audioTtsVoiceName', ttsVoiceName.value);
      await ipcRenderer.invoke('sulla-settings-set', 'audioTranscriptionMode', transcriptionMode.value);
      await ipcRenderer.invoke('sulla-settings-set', 'audioSttLanguage', sttLanguage.value);
      await ipcRenderer.invoke('sulla-settings-set', 'audioSttProvider', sttProvider.value);
      await ipcRenderer.invoke('sulla-settings-set', 'audioInputDeviceId', audioInputDeviceId.value);
    } catch (err) {
      console.error('[AudioSettings] Failed to save settings:', err);
    }
  }

  // ─── Provider connection checks ─────────────────────────────────

  async function checkProviders(): Promise<void> {
    for (const provider of ttsProviders.value) {
      // Keyless providers (e.g. the native OS voice) are always available — no vault lookup.
      if (!provider.vaultKey) {
        provider.connected = true;
        continue;
      }
      try {
        const result = await ipcRenderer.invoke(
          'integration-get-value',
          provider.vaultKey.integrationId,
          provider.vaultKey.property,
        );
        provider.connected = !!(result?.value);
      } catch {
        provider.connected = false;
      }
    }
  }

  async function checkGateway(): Promise<void> {
    try {
      const [urlResult, keyResult] = await Promise.all([
        ipcRenderer.invoke('integration-get-value', 'enterprise_gateway', 'gateway_url'),
        ipcRenderer.invoke('integration-get-value', 'enterprise_gateway', 'api_key'),
      ]);
      gatewayConnected.value = !!(urlResult?.value && keyResult?.value);
    } catch {
      gatewayConnected.value = false;
    }
  }

  // ─── Voice fetching ─────────────────────────────────────────────

  async function fetchVoices(): Promise<void> {
    if (loadingVoices.value) return;
    loadingVoices.value = true;

    try {
      if (ttsProvider.value === 'kokoro') {
        await fetchKokoroVoices();
      } else if (ttsProvider.value === 'system') {
        await fetchSystemVoices();
      } else if (ttsProvider.value === 'elevenlabs') {
        await fetchElevenLabsVoices();
      } else if (ttsProvider.value === 'grok') {
        await fetchGrokVoices();
      }
    } finally {
      loadingVoices.value = false;
    }
  }

  // Kokoro's English voices (bundled table — no network). Bella is the default.
  async function fetchKokoroVoices(): Promise<void> {
    try {
      const list: { key: string; name: string; accent: string; gender: string }[] = await ipcRenderer.invoke('voice-kokoro-voices');

      voices.value = list.map(v => ({
        value:       v.key,
        label:       v.key === 'af_bella' ? `${ v.name } (recommended)` : v.name,
        description: `${ v.accent } ${ v.gender.toLowerCase() }`,
      }));
    } catch {
      voices.value = [{ value: 'af_bella', label: 'Bella (recommended)', description: 'American female' }];
    }
    if (!voices.value.some(v => v.value === ttsVoice.value)) {
      ttsVoice.value = 'af_bella';
      ttsVoiceName.value = 'Bella';
      await saveSettings();
    }
    await refreshKokoroStatus();
  }

  // Fetch Grok's built-in voices from GET /v1/tts/voices, falling back to the known
  // built-ins when no key is set or the endpoint is unreachable.
  async function fetchGrokVoices(): Promise<void> {
    try {
      const result = await ipcRenderer.invoke('integration-get-value', 'grok', 'api_key');
      const apiKey = result?.value;

      if (!apiKey) {
        voices.value = getGrokStaticVoices();
        return;
      }

      const response = await fetch('https://api.x.ai/v1/tts/voices', {
        headers: { Authorization: `Bearer ${ apiKey }` },
      });

      if (!response.ok) {
        voices.value = getGrokStaticVoices();
        return;
      }

      // Response shape: either a bare array or { voices: [...] } of { voice_id, name }.
      const body = await response.json() as { voices?: { voice_id: string; name?: string }[] } | { voice_id: string; name?: string }[];
      const list = Array.isArray(body) ? body : (body.voices ?? []);

      if (list.length > 0) {
        voices.value = list.map(v => ({
          value: v.voice_id,
          label: v.name || v.voice_id,
        }));
      } else {
        voices.value = getGrokStaticVoices();
      }
    } catch {
      voices.value = getGrokStaticVoices();
    }
  }

  // Grok's five built-in voices (docs.x.ai). `eve` is the API default.
  function getGrokStaticVoices(): { value: string; label: string; description?: string }[] {
    return [
      { value: 'eve', label: 'Eve', description: 'default' },
      { value: 'ara', label: 'Ara' },
      { value: 'leo', label: 'Leo' },
      { value: 'rex', label: 'Rex' },
      { value: 'sal', label: 'Sal' },
    ];
  }

  // Enumerate the OS speech-engine voices exposed through the browser SpeechSynthesis API.
  // In Electron/Chromium on macOS these are the native system voices (Samantha, Alex, the Siri voices, …).
  async function fetchSystemVoices(): Promise<void> {
    const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
    if (!synth) {
      voices.value = [{ value: 'auto', label: 'Automatic (system default)' }];
      return;
    }

    // Chromium loads voices lazily — the first getVoices() call can return []. Wait briefly for voiceschanged.
    let list = synth.getVoices();
    if (list.length === 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1000);
        synth.addEventListener('voiceschanged', () => { clearTimeout(timer); resolve() }, { once: true });
      });
      list = synth.getVoices();
    }

    const english = list.filter(v => v.lang?.toLowerCase().startsWith('en'));
    const pool = english.length > 0 ? english : list;

    voices.value = [
      { value: 'auto', label: 'Automatic (system default)' },
      ...pool.map(v => ({
        value:       v.voiceURI,
        label:       v.name,
        description: v.lang,
      })),
    ];
  }

  async function fetchElevenLabsVoices(): Promise<void> {
    try {
      const result = await ipcRenderer.invoke('integration-get-value', 'elevenlabs', 'api_key');
      const apiKey = result?.value;

      if (!apiKey) {
        voices.value = getStaticVoices();
        return;
      }

      const response = await fetch('https://api.elevenlabs.io/v1/voices', {
        headers: { 'xi-api-key': apiKey },
      });

      if (!response.ok) {
        voices.value = getStaticVoices();
        return;
      }

      const body = await response.json() as { voices?: { voice_id: string; name: string; category?: string }[] };

      if (body.voices && body.voices.length > 0) {
        voices.value = body.voices.map(v => ({
          value:       v.voice_id,
          label:       v.name,
          description: v.category,
        }));
      } else {
        voices.value = getStaticVoices();
      }
    } catch {
      voices.value = getStaticVoices();
    }
  }

  function getStaticVoices(): { value: string; label: string; description?: string }[] {
    return [
      { value: 'cgSgspJ2msm6clMCkdW9', label: 'Jessica', description: 'premade, default' },
    ];
  }

  // ─── Device enumeration ─────────────────────────────────────────

  async function fetchAudioDevices(): Promise<void> {
    if (loadingDevices.value) return;
    loadingDevices.value = true;
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop()));
      const devices = await navigator.mediaDevices.enumerateDevices();
      const hiddenDevices = ['blackhole', 'sulla audio mirror'];
      audioInputDevices.value = devices
        .filter(d => d.kind === 'audioinput')
        .filter(d => !hiddenDevices.some(h => (d.label || '').toLowerCase().includes(h)))
        .map((d, i) => ({
          value: d.deviceId,
          label: d.label || `Microphone ${ i + 1 }`,
        }));
    } catch (err) {
      console.warn('[AudioSettings] Failed to enumerate audio devices:', err);
      audioInputDevices.value = [];
    } finally {
      loadingDevices.value = false;
    }
  }

  // ─── Voice preview ──────────────────────────────────────────────

  // Speak a sample through the OS speech engine using the currently-selected system voice.
  function previewSystemVoice(text: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
      if (!synth) {
        reject(new Error('System speech is not available in this window.'));
        return;
      }
      synth.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      if (ttsVoice.value && ttsVoice.value !== 'auto') {
        const match = synth.getVoices().find(v => v.voiceURI === ttsVoice.value);
        if (match) utterance.voice = match;
      }
      utterance.onend = () => resolve();
      utterance.onerror = (event) => reject(new Error(`System speech failed: ${ event.error || 'unknown error' }`));
      synth.speak(utterance);
    });
  }

  async function previewVoice(): Promise<void> {
    if (previewPlaying.value) return;
    previewPlaying.value = true;
    ttsPreviewError.value = null;
    try {
      // System provider speaks natively in the renderer — no ElevenLabs round-trip.
      if (ttsProvider.value === 'system') {
        await previewSystemVoice('Hello, this is how I sound.');
        return;
      }
      if (ttsProvider.value === 'kokoro' && kokoroStatus.value.phase !== 'ready') {
        downloadKokoro().catch(() => undefined);
        ttsPreviewError.value = 'The on-device voice is still downloading — try again when it finishes.';
        return;
      }
      const result = await ipcRenderer.invoke('audio-speak', { text: 'Hello, this is how I sound.' });
      if (result?.audio) {
        const blob = new Blob([result.audio], { type: result.mimeType || 'audio/mpeg' });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        await new Promise<void>((resolve) => {
          audio.onended = () => { URL.revokeObjectURL(url); resolve() };
          audio.onerror = () => { URL.revokeObjectURL(url); resolve() };
          audio.play().catch(() => resolve());
        });
      }
    } catch (err) {
      console.warn('[AudioSettings] Voice preview failed:', err);
      ttsPreviewError.value = err instanceof Error ? err.message : 'Voice preview failed.';
    } finally {
      previewPlaying.value = false;
    }
  }

  // ─── Init ───────────────────────────────────────────────────────

  onMounted(async() => {
    await loadSettings();
    await checkProviders();
    await checkGateway();
    await checkGrokSttConnection();
    await fetchVoices();
    await fetchAudioDevices();

    // Check if audio-driver is already running
    try {
      const state = await ipc.invoke('audio-driver:get-state');
      micRunning.value = !!state?.micRunning || !!state?.running;
      speakerRunning.value = !!state?.speakerRunning;
      if (state?.permissions) {
        micPermission.value = state.permissions.microphone || 'unknown';
      }
    } catch { /* ignore */ }

    // Check permissions and loopback status on load
    await checkMicPermission();
    await checkLoopbackStatus();

    await fetchSpeakerDevices();
    await fetchSpeakerVolume();

    // Check whisper status
    await detectWhisper();

    // Check if whisper transcription is already running
    try {
      const tStatus = await ipc.invoke('audio-driver:transcribe-status');
      whisperTranscribing.value = !!tStatus?.active;
      if (tStatus?.mode) whisperTranscribeMode.value = tStatus.mode;
    } catch { /* ignore */ }
  });

  onUnmounted(() => {
    ipc.removeListener('voice-kokoro-status-changed', onKokoroStatus);
    ipc.removeListener('audio-driver:state', onCaptureState);
    ipc.removeListener('audio-driver:mic-error', onMicError);
    ipc.removeListener('audio-driver:mic-vad', onMicVad);
    ipc.removeListener('audio-driver:speaker-level', onSpeakerLevel);
    ipc.removeListener('audio-driver:speaker-level', onSpeakerLevelForMeter);
    ipc.removeListener('audio-driver:volume-changed', onVolumeChanged);
    ipc.removeListener('audio-driver:state', onDriverState);
    ipc.removeListener('audio-driver:whisper-status', onWhisperStatus);
    ipc.removeListener('audio-driver:whisper-progress', onWhisperProgress);
    ipc.removeListener('gateway-transcript', onWhisperTestTranscript);
    stopTranscribeStatsPoll();
    if (whisperTranscribing.value) {
      ipc.invoke('audio-driver:transcribe-stop').catch(() => {});
      ipc.invoke('audio-driver:stop-mic', 'whisper-test').catch(() => {});
    }
    // Leaving the screen ends any mic test it started.
    if (micTestRecording.value) {
      stopMicTestRecording().catch(() => {});
    }
    if (micRunning.value) {
      ipc.invoke('audio-driver:stop-mic', 'audio-settings-test').catch(() => {});
    }
    if (micTestAudioUrl.value) {
      URL.revokeObjectURL(micTestAudioUrl.value);
    }
  });

  return {
    ttsProviders,
    ttsProvider,
    kokoroStatus,
    downloadKokoro,
    ttsVoice,
    voices,
    loadingVoices,
    previewPlaying,
    ttsPreviewError,
    selectTtsProvider,
    onVoiceChange,
    fetchVoices,
    previewVoice,
    audioCaptureActive,
    gatewayConnected,
    transcriptionMode,
    saveSettings,
    audioInputDeviceId,
    audioInputDevices,
    loadingDevices,
    fetchAudioDevices,
    onMicDeviceChange,
    sttLanguage,
    sttProvider,
    onSttProviderChange,
    grokSttConnected,
    speakerDeviceId,
    speakerOutputDevices,
    fetchSpeakerDevices,
    onSpeakerDeviceChange,
    speakerVolume,
    speakerMuted,
    speakerVolumeDisplay,
    onSpeakerMuteToggle,
    onSpeakerVolumeUp,
    onSpeakerVolumeDown,
    speakerMeterPct,
    micPermission,
    micPermissionChecking,
    micError,
    requestMicPermission,
    checkMicPermission,
    loopbackInstalled,
    loopbackName,
    loopbackInstalling,
    loopbackError,
    installLoopback,
    checkLoopbackStatus,
    micRunning,
    speakerRunning,
    speakerTransitioning,
    toggleMicDriver,
    toggleSpeakerDriver,
    driverMicLevel,
    driverMicDb,
    vadSpeaking,
    vadFanNoise,
    vadNoiseFloorDb,
    vadZcr,
    vadVariance,
    vadPitch,
    vadCentroid,
    MIC_TEST_MODES,
    micTestMode,
    micTestRecording,
    micTestDuration,
    micTestAudioUrl,
    toggleMicTestRecording,
    WHISPER_MODEL_CATALOG,
    whisperInstalled,
    whisperVersion,
    whisperModels,
    whisperDetecting,
    whisperDownloading,
    whisperModelToDownload,
    availableWhisperModels,
    activeWhisperModel,
    setActiveWhisperModel,
    getModelMeta,
    detectWhisper,
    downloadWhisperModel,
    deleteWhisperModel,
    whisperBusy,
    whisperProgressPhase,
    whisperProgressPct,
    whisperLogLines,
    whisperTranscribing,
    whisperTestEntries,
    toggleWhisperTest,
  };
}
