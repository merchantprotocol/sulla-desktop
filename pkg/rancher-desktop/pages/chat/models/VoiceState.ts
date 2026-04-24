import type { MessageId } from '../types/chat';

export type VoiceState =
  | { phase: 'idle' }
  | { phase: 'recording'; startedAt: number; interimMessageId: MessageId; level: number }
  | { phase: 'playing';   refId: MessageId; startedAt: number; endsAt?: number };

export const voiceIdle = (): VoiceState => ({ phase: 'idle' });

export const isRecording = (v: VoiceState): boolean => v.phase === 'recording';
export const isPlaying   = (v: VoiceState): boolean => v.phase === 'playing';
