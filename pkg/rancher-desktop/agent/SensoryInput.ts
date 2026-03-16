// SensoryInput - Captures input from various sources (mic/text/camera)
// Outputs to ContextDetector without blocking

import type { SensoryInput, SensoryMetadata } from './types';

let inputCounter = 0;

function generateInputId(): string {
  return `input_${ Date.now() }_${ ++inputCounter }`;
}

export class Sensory {
  /**
   * Create a SensoryInput from text (keyboard)
   */
  createTextInput(text: string, metadata?: Partial<SensoryMetadata>): SensoryInput {
    return {
      id:        generateInputId(),
      type:      'text',
      data:      text.trim(),
      metadata:  {
        source: 'keyboard',
        ...metadata,
      },
      timestamp: Date.now(),
    };
  }

  /**
   * Create a SensoryInput from audio (microphone)
   * Note: Audio data should be transcribed before calling this
   */
  createAudioInput(transcribedText: string, metadata?: Partial<SensoryMetadata>): SensoryInput {
    return {
      id:        generateInputId(),
      type:      'audio',
      data:      transcribedText.trim(),
      metadata:  {
        source: 'microphone',
        ...metadata,
      },
      timestamp: Date.now(),
    };
  }

  /**
   * Create a SensoryInput from API call
   */
  createApiInput(text: string, metadata?: Partial<SensoryMetadata>): SensoryInput {
    return {
      id:        generateInputId(),
      type:      'text',
      data:      text.trim(),
      metadata:  {
        source: 'api',
        ...metadata,
      },
      timestamp: Date.now(),
    };
  }

  /**
   * Create a SensoryInput from calendar event trigger
   */
  createCalendarInput(text: string, metadata?: Partial<SensoryMetadata>): SensoryInput {
    return {
      id:        generateInputId(),
      type:      'text',
      data:      text.trim(),
      metadata:  {
        source:           'calendar',
        isBackgroundTask: true,
        ...metadata,
      },
      timestamp: Date.now(),
    };
  }

  /**
   * Create a SensoryInput from heartbeat trigger
   */
  createHeartbeatInput(text: string, metadata?: Partial<SensoryMetadata>): SensoryInput {
    return {
      id:        generateInputId(),
      type:      'text',
      data:      text.trim(),
      metadata:  {
        source:           'heartbeat',
        isBackgroundTask: true,
        ...metadata,
      },
      timestamp: Date.now(),
    };
  }

  /**
   * Extract text content from any SensoryInput
   */
  extractText(input: SensoryInput): string {
    return input.data;
  }

  /**
   * Get metadata from input
   */
  getMetadata(input: SensoryInput): SensoryMetadata {
    return input.metadata;
  }
}

// Singleton instance
let sensoryInstance: Sensory | null = null;

export function getSensory(): Sensory {
  if (!sensoryInstance) {
    sensoryInstance = new Sensory();
  }

  return sensoryInstance;
}
