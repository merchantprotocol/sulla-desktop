// Voice system — barrel exports
export { TypedEventEmitter } from './TypedEventEmitter';
export { VoiceRecorderService, type TranscriptionFragment, type VoiceRecorderEvents, type VoiceRecorderConfig } from './VoiceRecorderService';
export { TTSPlayerService, type TTSPlayerEvents, type TTSPlayerConfig } from './TTSPlayerService';
export { VoicePipeline, type VoiceMode, type PipelineState, type SecretaryAnalysis, type VoicePipelineConfig } from './VoicePipeline';
export { useVoiceSession, type UseVoiceSessionOptions, type UseVoiceSessionReturn } from './useVoiceSession';
export { setVoiceLogContext, vlog, type VoiceComponent } from './VoiceLogger';
