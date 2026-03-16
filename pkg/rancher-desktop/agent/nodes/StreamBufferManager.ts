import { RedisClient } from '../database/RedisClient';

// Types for streaming buffer management
interface StreamBuffer {
  threadId:      string;
  bufferData:    string[];
  lastActivity:  number;
  speakingState: 'active' | 'paused' | 'complete';
  bufferTimeout: NodeJS.Timeout | null;
  instanceId:    string;
}

interface BufferConfig {
  pauseThreshold:      number;    // ms to wait after speech pause
  maxBufferTime:       number;     // ms maximum buffer duration
  minProcessingLength: number; // minimum chars before processing
  flushOnSilence:      number;    // ms of silence before force flush
}

/**
 * Stream Buffer Manager
 *
 * Handles partial speech transcripts from 11Labs streaming:
 * - Buffers incoming speech chunks during active speaking
 * - Detects speech pauses and completion points
 * - Manages serverless instance handoffs
 * - Prevents processing incomplete thoughts
 *
 * Timing Strategy:
 * - Active speaking: Buffer continuously, no processing
 * - Speech pause (1.5s): Evaluate if complete thought
 * - Long pause (3s): Force flush and process
 * - Max buffer (15s): Force process regardless
 */
export class StreamBufferManager {
  private static instance: StreamBufferManager | null = null;
  private redisClient:     RedisClient;
  private activeBuffers = new Map<string, StreamBuffer>();

  private readonly config: BufferConfig = {
    pauseThreshold:      1500,      // 1.5s pause suggests sentence completion
    maxBufferTime:       15000,      // 15s maximum buffer to prevent endless waiting
    minProcessingLength: 20,   // 20 chars minimum for meaningful processing
    flushOnSilence:      3000,       // 3s silence forces processing
  };

  constructor() {
    this.redisClient = RedisClient.getInstance();
  }

  static getInstance(): StreamBufferManager {
    if (!StreamBufferManager.instance) {
      StreamBufferManager.instance = new StreamBufferManager();
    }
    return StreamBufferManager.instance;
  }

  /**
   * Add speech chunk to buffer (called continuously during speaking)
   */
  async addSpeechChunk(threadId: string, speechChunk: string, isComplete = false): Promise<{
    shouldProcess:   boolean;
    bufferedContent: string;
    reason:          string;
  }> {
    const instanceId = `instance_${ Date.now() }_${ Math.random().toString(36).substr(2, 5) }`;
    let buffer = this.activeBuffers.get(threadId);

    if (!buffer) {
      buffer = {
        threadId,
        bufferData:    [],
        lastActivity:  Date.now(),
        speakingState: 'active',
        bufferTimeout: null,
        instanceId,
      };
      this.activeBuffers.set(threadId, buffer);
      console.log(`[StreamBuffer] Created new buffer for thread ${ threadId }`);
    }

    // Update buffer with new speech chunk
    buffer.bufferData.push(speechChunk);
    buffer.lastActivity = Date.now();
    buffer.speakingState = isComplete ? 'complete' : 'active';

    // Clear existing timeout if speech is continuing
    if (buffer.bufferTimeout && !isComplete) {
      clearTimeout(buffer.bufferTimeout);
      buffer.bufferTimeout = null;
    }

    const bufferedContent = buffer.bufferData.join(' ');
    console.log(`[StreamBuffer] Added chunk: "${ speechChunk }" (total: ${ bufferedContent.length } chars)`);

    // Decision logic for when to process
    const shouldProcess = await this.shouldProcessBuffer(buffer, isComplete);

    if (shouldProcess.process) {
      // Store buffer in Redis for serverless handoff before processing
      await this.storeBufferInRedis(threadId, bufferedContent);
      this.activeBuffers.delete(threadId);

      return {
        shouldProcess: true,
        bufferedContent,
        reason:        shouldProcess.reason,
      };
    }

    // Set timeout for pause detection if speech isn't marked complete
    if (!isComplete && !buffer.bufferTimeout) {
      buffer.bufferTimeout = setTimeout(() => {
        this.handleSpeechPause(threadId);
      }, this.config.pauseThreshold);
    }

    return {
      shouldProcess: false,
      bufferedContent,
      reason:        'Continuing to buffer - user still speaking',
    };
  }

  /**
   * Determine if buffer should be processed based on various conditions
   */
  private async shouldProcessBuffer(buffer: StreamBuffer, isComplete: boolean): Promise<{
    process: boolean;
    reason:  string;
  }> {
    const bufferedContent = buffer.bufferData.join(' ');
    const bufferAge = Date.now() - (buffer.lastActivity - this.config.pauseThreshold);

    // Force processing conditions
    if (isComplete) {
      return { process: true, reason: 'Speech marked as complete' };
    }

    if (bufferAge > this.config.maxBufferTime) {
      return { process: true, reason: 'Maximum buffer time exceeded (15s)' };
    }

    if (bufferedContent.length < this.config.minProcessingLength) {
      return { process: false, reason: 'Buffer too short for meaningful processing' };
    }

    // Check for natural completion indicators
    const hasCompleteSentence = /[.!?]\s*$/.test(bufferedContent.trim());
    const hasCompleteThought = this.detectCompleteThought(bufferedContent);

    if (hasCompleteSentence && hasCompleteThought) {
      return { process: true, reason: 'Complete sentence and thought detected' };
    }

    return { process: false, reason: 'Waiting for complete thought or natural pause' };
  }

  /**
   * Handle speech pause detection (called by timeout)
   */
  private async handleSpeechPause(threadId: string): Promise<void> {
    const buffer = this.activeBuffers.get(threadId);
    if (!buffer) return;

    const bufferedContent = buffer.bufferData.join(' ');
    const timeSinceLastActivity = Date.now() - buffer.lastActivity;

    console.log(`[StreamBuffer] Speech pause detected for ${ threadId } (${ timeSinceLastActivity }ms silence)`);

    // Extended silence - force processing
    if (timeSinceLastActivity >= this.config.flushOnSilence) {
      console.log(`[StreamBuffer] Force processing due to extended silence (${ timeSinceLastActivity }ms)`);

      await this.storeBufferInRedis(threadId, bufferedContent);
      this.activeBuffers.delete(threadId);

      // Trigger serverless instance handoff
      await this.triggerServerlessHandoff(threadId, bufferedContent, 'silence_timeout');
      return;
    }

    // Check if current buffer represents complete thought
    if (this.detectCompleteThought(bufferedContent) && bufferedContent.length >= this.config.minProcessingLength) {
      console.log(`[StreamBuffer] Processing complete thought after pause`);

      await this.storeBufferInRedis(threadId, bufferedContent);
      this.activeBuffers.delete(threadId);

      // Trigger serverless instance handoff
      await this.triggerServerlessHandoff(threadId, bufferedContent, 'complete_thought');
      return;
    }

    // Continue waiting but set longer timeout
    buffer.bufferTimeout = setTimeout(() => {
      this.handleSpeechPause(threadId);
    }, this.config.flushOnSilence - timeSinceLastActivity);
  }

  /**
   * Detect if buffered content represents a complete thought
   */
  private detectCompleteThought(content: string): boolean {
    const trimmed = content.trim();

    // Empty or too short
    if (trimmed.length < this.config.minProcessingLength) return false;

    // Has sentence ending punctuation
    if (/[.!?]\s*$/.test(trimmed)) return true;

    // Complete request patterns
    const completePatterns = [
      /^(can you|could you|please|I need|I want|help me).+/i,
      /^(what|how|when|where|why).+/i,
      /^(create|build|make|generate|write|design).+/i,
      /(thank you|thanks|that's all|goodbye|bye)$/i,
    ];

    return completePatterns.some(pattern => pattern.test(trimmed));
  }

  /**
   * Store buffer content in Redis for serverless instance handoff
   */
  private async storeBufferInRedis(threadId: string, content: string): Promise<void> {
    try {
      await this.redisClient.initialize();

      const bufferData = {
        threadId,
        content,
        timestamp:   Date.now(),
        processed:   false,
        handoffType: 'speech_buffer',
      };

      await this.redisClient.set(`stream_buffer:${ threadId }`, JSON.stringify(bufferData));
      console.log(`[StreamBuffer] Stored buffer in Redis for thread ${ threadId }: "${ content.substring(0, 50) }..."`);
    } catch (error) {
      console.error(`[StreamBuffer] Failed to store buffer in Redis:`, error);
    }
  }

  /**
   * Trigger new serverless instance to process complete buffer
   */
  private async triggerServerlessHandoff(threadId: string, content: string, reason: string): Promise<void> {
    console.log(`[StreamBuffer] Serverless handoff for ${ threadId } — reason=${ reason }, content="${ content.substring(0, 80) }"`);
  }

  /**
   * Get current buffer status for monitoring
   */
  getBufferStatus(threadId: string): {
    exists:   boolean;
    content?: string;
    age?:     number;
    state?:   string;
  } {
    const buffer = this.activeBuffers.get(threadId);

    if (!buffer) {
      return { exists: false };
    }

    return {
      exists:  true,
      content: buffer.bufferData.join(' '),
      age:     Date.now() - buffer.lastActivity,
      state:   buffer.speakingState,
    };
  }

  /**
   * Force flush buffer (emergency processing)
   */
  async forceFlushBuffer(threadId: string): Promise<string | null> {
    const buffer = this.activeBuffers.get(threadId);
    if (!buffer) return null;

    const content = buffer.bufferData.join(' ');
    await this.storeBufferInRedis(threadId, content);
    this.activeBuffers.delete(threadId);

    console.log(`[StreamBuffer] Force flushed buffer for ${ threadId }`);
    return content;
  }
}
