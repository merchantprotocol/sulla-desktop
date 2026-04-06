/**
 * useVoiceSession — thin Vue composable for voice features.
 *
 * After the audio-driver migration, microphone capture and transcription
 * are handled by the audio-driver lifecycle (main process). This composable
 * now only manages TTS playback and exposes recording state refs that are
 * updated via IPC from the audio-driver.
 *
 * Called once per BrowserTabChat instance.
 */

import { ref, readonly, onUnmounted, type Ref } from 'vue';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import type { ChatInterface, ChatMessage } from '../../pages/agent/ChatInterface';
import { TTSPlayerService } from './TTSPlayerService';

// ─── Types ──────────────────────────────────────────────────────

export type VoiceMode = 'voice' | 'secretary' | 'intake';
export type PipelineState = 'IDLE' | 'LISTENING' | 'THINKING' | 'SPEAKING';

export interface UseVoiceSessionOptions {
  chatController: ChatInterface;
  messages: Ref<ChatMessage[]>;
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
  const { chatController, onError: _onError } = options;

  // ── Reactive state ──
  const isRecording = ref(false);
  const audioLevel = ref(0);
  const recordingDuration = ref('0:00');
  const isTTSPlaying = ref(false);
  const pipelineState = ref<PipelineState>('IDLE');
  const voiceMode = ref<VoiceMode>('voice');

  // ── TTS service (kept from original) ──
  const ttsPlayer = new TTSPlayerService({
    ipcInvoke: ipcRenderer.invoke.bind(ipcRenderer),
  });

  const unsubs: Array<() => void> = [];

  unsubs.push(
    ttsPlayer.on('playbackStart', () => {
      isTTSPlaying.value = true;
      pipelineState.value = 'SPEAKING';
    }),
    ttsPlayer.on('queueEmpty', () => {
      isTTSPlaying.value = false;
      if (pipelineState.value === 'SPEAKING') {
        pipelineState.value = isRecording.value ? 'LISTENING' : 'IDLE';
      }
    }),
  );

  // ── Listen for speak events from the agent ──
  unsubs.push(
    chatController.onSpeakDispatch((text, _threadId, _pipelineSequence) => {
      if (text.trim()) {
        ttsPlayer.enqueue(text.trim(), `speak_${Date.now()}`);
        if (pipelineState.value === 'THINKING') {
          pipelineState.value = 'SPEAKING';
        }
      }
    }),
  );

  // ── Audio-driver IPC listeners ──
  // The audio-driver lifecycle sends recording state updates via IPC.
  // These will be wired when the audio-driver is fully integrated.
  const onAudioState = (_event: any, state: { running: boolean }) => {
    isRecording.value = state.running;
    if (state.running) {
      pipelineState.value = 'LISTENING';
    } else if (pipelineState.value === 'LISTENING') {
      pipelineState.value = 'IDLE';
    }
  };

  const onMicLevel = (_event: any, level: number) => {
    audioLevel.value = level;
  };

  ipcRenderer.on('audio-driver:state', onAudioState);
  ipcRenderer.on('audio-driver:mic-level', onMicLevel);

  // ── Actions ──
  async function toggleRecording(): Promise<void> {
    // Delegate to audio-driver lifecycle via IPC
    ipcRenderer.send('audio-driver:toggle');
  }

  function stopTTS(): void {
    ttsPlayer.stop();
  }

  // ── Cleanup ──
  function dispose(): void {
    for (const unsub of unsubs) unsub();
    unsubs.length = 0;
    ipcRenderer.removeListener('audio-driver:state', onAudioState);
    ipcRenderer.removeListener('audio-driver:mic-level', onMicLevel);
    ttsPlayer.dispose();
  }

  onUnmounted(dispose);

  return {
    isRecording:       readonly(isRecording),
    audioLevel:        readonly(audioLevel),
    recordingDuration: readonly(recordingDuration),
    isTTSPlaying:      readonly(isTTSPlaying),
    pipelineState:     readonly(pipelineState),
    voiceMode,
    toggleRecording,
    stopTTS,
    dispose,
  };
}
