/**
 * useVoiceSession — thin Vue composable bridging voice services to reactivity.
 *
 * Creates VoiceRecorderService, TTSPlayerService, and VoicePipeline.
 * Maps service events to Vue refs for template binding.
 * Called once per BrowserTabChat instance.
 */

import { ref, readonly, watch, onUnmounted, type Ref } from 'vue';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import type { ChatInterface, ChatMessage } from '../../pages/agent/ChatInterface';
import { VoiceRecorderService } from './VoiceRecorderService';
import { TTSPlayerService } from './TTSPlayerService';
import { VoicePipeline, type VoiceMode, type PipelineState, type SecretaryAnalysis } from './VoicePipeline';
import { setVoiceLogContext } from './VoiceLogger';

// ─── Types ──────────────────────────────────────────────────────

export interface UseVoiceSessionOptions {
  chatController: ChatInterface;
  messages: Ref<ChatMessage[]>;
  onSecretaryResult?: (result: SecretaryAnalysis) => void;
  onError?: (message: string) => void;
}

export interface UseVoiceSessionReturn {
  // Reactive state for template binding
  isRecording: Readonly<Ref<boolean>>;
  audioLevel: Readonly<Ref<number>>;
  recordingDuration: Readonly<Ref<string>>;
  isTTSPlaying: Readonly<Ref<boolean>>;
  pipelineState: Readonly<Ref<PipelineState>>;
  voiceMode: Ref<VoiceMode>;

  // Actions
  toggleRecording(): Promise<void>;
  stopTTS(): void;

  // Cleanup
  dispose(): void;
}

// ─── Composable ─────────────────────────────────────────────────

export function useVoiceSession(options: UseVoiceSessionOptions): UseVoiceSessionReturn {
  const { chatController, messages, onSecretaryResult, onError } = options;

  // ── Reactive state ──
  const isRecording = ref(false);
  const audioLevel = ref(0);
  const recordingDuration = ref('0:00');
  const isTTSPlaying = ref(false);
  const pipelineState = ref<PipelineState>('IDLE');
  const voiceMode = ref<VoiceMode>('voice');

  // ── Create services ──
  const recorder = new VoiceRecorderService({
    ipcInvoke: ipcRenderer.invoke.bind(ipcRenderer),
  });

  const ttsPlayer = new TTSPlayerService({
    ipcInvoke: ipcRenderer.invoke.bind(ipcRenderer),
  });

  const pipeline = new VoicePipeline({
    recorder,
    ttsPlayer,
    chatController,
    messages,
    mode: voiceMode,
    onSecretaryResult,
  });

  // ── Bridge service events → Vue refs ──
  const unsubs: Array<() => void> = [];

  unsubs.push(
    recorder.on('recordingStart', () => {
      isRecording.value = true;
    }),
    recorder.on('recordingStop', () => {
      isRecording.value = false;
    }),
    recorder.on('levelChange', (level) => {
      audioLevel.value = level;
    }),
  );

  if (onError) {
    unsubs.push(
      recorder.on('error', (msg) => onError(msg)),
    );
  }

  // Poll recording duration from service (it updates its own property)
  let durationInterval: ReturnType<typeof setInterval> | null = null;
  unsubs.push(
    recorder.on('recordingStart', () => {
      durationInterval = setInterval(() => {
        recordingDuration.value = recorder.recordingDuration;
      }, 250);
    }),
    recorder.on('recordingStop', () => {
      if (durationInterval) {
        clearInterval(durationInterval);
        durationInterval = null;
      }
      recordingDuration.value = '0:00';
    }),
  );

  unsubs.push(
    ttsPlayer.on('playbackStart', () => {
      isTTSPlaying.value = true;
    }),
    ttsPlayer.on('queueEmpty', () => {
      isTTSPlaying.value = false;
    }),
  );

  // Track pipeline state changes by polling (pipeline updates its own .state property)
  const stateInterval = setInterval(() => {
    if (pipelineState.value !== pipeline.state) {
      pipelineState.value = pipeline.state;
    }
  }, 100);

  // ── Set voice log context (thread ID for persistent logging) ──
  const stopThreadWatch = watch(
    () => chatController.threadId.value,
    (id) => {
      if (id) setVoiceLogContext(id);
    },
    { immediate: true },
  );

  // ── Start pipeline ──
  pipeline.start();

  // ── Actions ──
  async function toggleRecording(): Promise<void> {
    await recorder.toggle();
  }

  function stopTTS(): void {
    ttsPlayer.stop();
  }

  // ── Cleanup ──
  function dispose(): void {
    stopThreadWatch();
    clearInterval(stateInterval);
    if (durationInterval) {
      clearInterval(durationInterval);
      durationInterval = null;
    }
    for (const unsub of unsubs) unsub();
    unsubs.length = 0;
    pipeline.dispose();
    ttsPlayer.dispose();
    recorder.dispose();
  }

  // Auto-cleanup on component unmount
  onUnmounted(dispose);

  return {
    isRecording:     readonly(isRecording),
    audioLevel:      readonly(audioLevel),
    recordingDuration: readonly(recordingDuration),
    isTTSPlaying:    readonly(isTTSPlaying),
    pipelineState:   readonly(pipelineState),
    voiceMode,
    toggleRecording,
    stopTTS,
    dispose,
  };
}
