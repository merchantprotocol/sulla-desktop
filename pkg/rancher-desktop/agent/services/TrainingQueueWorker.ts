/**
 * TrainingQueueWorker
 *
 * Processes document-to-training-data jobs from a Redis queue.
 * Each job represents a file that needs to be chunked and sent to an LLM
 * to generate training pairs, which are appended to the user's chosen
 * output file.
 *
 * Queue key: `training:doc_queue` (Redis list)
 * Each entry is a JSON string: { filePath, prompt, modelId, modelProvider, outputFilename, queuedAt }
 */

import fs from 'node:fs';
import path from 'node:path';

import { redisClient } from '../database/RedisClient';

const QUEUE_KEY = 'training:doc_queue';
const BATCH_SIZE = 5;

export interface TrainingQueueEntry {
  filePath:       string;
  prompt:         string;
  modelId:        string;
  modelProvider:  string;
  outputFilename: string;
  queuedAt:       string;
}

export type QueueProgressCallback = (event: {
  phase:      'queue-start' | 'queue-file-ok' | 'queue-file-error' | 'queue-done';
  file?:      string;
  pairs?:     number;
  processed?: number;
  total?:     number;
  message:    string;
}) => void;

let isProcessing = false;

/**
 * Add entries to the Redis queue
 */
export async function enqueueTrainingFiles(entries: TrainingQueueEntry[]): Promise<number> {
  if (entries.length === 0) return 0;
  const serialized = entries.map(e => JSON.stringify(e));
  return redisClient.rpush(QUEUE_KEY, ...serialized);
}

/**
 * Get the number of pending items in the queue
 */
export async function getQueueLength(): Promise<number> {
  const client = redisClient.getClient();
  return client.llen(QUEUE_KEY);
}

/**
 * Check if the worker is currently processing
 */
export function isQueueProcessing(): boolean {
  return isProcessing;
}

/**
 * Process all items in the queue in batches.
 *
 * Pops items from the front of the list, processes them through
 * the documents_processor.py script, and appends results to the
 * output file specified in each entry.
 */
export async function processQueue(
  onProgress?: QueueProgressCallback,
): Promise<{ processed: number; totalPairs: number }> {
  if (isProcessing) {
    onProgress?.({ phase: 'queue-start', message: 'Queue worker already running' });
    return { processed: 0, totalPairs: 0 };
  }

  isProcessing = true;
  let processed = 0;
  let totalPairs = 0;

  try {
    const pending = await getQueueLength();
    onProgress?.({ phase: 'queue-start', message: `Processing ${ pending } queued file(s)`, total: pending, processed: 0 });

    // Process in batches
    while (true) {
      const batch = await popBatch(BATCH_SIZE);
      if (batch.length === 0) break;

      for (const entry of batch) {
        try {
          const pairs = await processEntry(entry, onProgress);
          processed++;
          totalPairs += pairs;
          onProgress?.({
            phase:     'queue-file-ok',
            file:      path.basename(entry.filePath),
            pairs,
            processed,
            total:     pending,
            message:   `Processed ${ path.basename(entry.filePath) } (${ pairs } pairs)`,
          });
        } catch (err) {
          processed++;
          onProgress?.({
            phase:     'queue-file-error',
            file:      path.basename(entry.filePath),
            processed,
            total:     pending,
            message:   `Failed: ${ path.basename(entry.filePath) } — ${ err instanceof Error ? err.message : String(err) }`,
          });
        }
      }
    }

    onProgress?.({
      phase:     'queue-done',
      processed,
      total:     totalPairs,
      message:   `Queue complete — ${ processed } file(s), ${ totalPairs } training pair(s)`,
    });
  } finally {
    isProcessing = false;
  }

  return { processed, totalPairs };
}

// ─── Internal helpers ───

/**
 * Pop up to `count` entries from the front of the queue
 */
async function popBatch(count: number): Promise<TrainingQueueEntry[]> {
  const entries: TrainingQueueEntry[] = [];
  for (let i = 0; i < count; i++) {
    const raw = await redisClient.lpop(QUEUE_KEY);
    if (!raw) break;
    try {
      entries.push(JSON.parse(raw));
    } catch {
      // Malformed entry — skip
    }
  }
  return entries;
}

/**
 * Process a single queue entry by spawning documents_processor.py
 * with the file, prompt, model, and output target.
 *
 * Returns the number of training pairs generated.
 */
async function processEntry(
  entry: TrainingQueueEntry,
  _onProgress?: QueueProgressCallback,
): Promise<number> {
  const { getLlamaCppService, getTrainingScriptsDir } = await import('./LlamaCppService');
  const service = getLlamaCppService();
  const python = service.getTrainingPython();

  if (!python) {
    throw new Error('Training environment not installed');
  }

  const { app } = require('electron');
  const llmRoot = path.join(app.getPath('userData'), 'llm');
  const scriptsDir = getTrainingScriptsDir();
  const docScript = path.join(scriptsDir, 'documents_processor.py');

  // Build arguments
  const args = [
    docScript,
    '--llm-root', llmRoot,
    '--files', entry.filePath,
    '--prompt', entry.prompt,
    '--model', entry.modelId,
    '--provider', entry.modelProvider,
    '--output', entry.outputFilename,
  ];

  // Resolve API key for remote providers
  let apiKey = '';
  if (entry.modelProvider !== 'local') {
    try {
      const { SullaSettingsModel } = await import('../database/models/SullaSettingsModel');
      apiKey = await SullaSettingsModel.get(`${ entry.modelProvider.toLowerCase() }ApiKey`, '');
    } catch {
      // Settings may not be ready
    }
  }

  const env = { ...process.env };
  if (apiKey) {
    env.LLM_API_KEY = apiKey;
  }

  return new Promise<number>((resolve, reject) => {
    const { spawn } = require('child_process');
    const proc = spawn(python, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    let pairsGenerated = 0;
    let stdoutBuf = '';

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        const okMatch = /\[OK\]\s+Processed.*?:\s+(.+?)\s+\((\d+)\s+pairs?\)/.exec(trimmed);
        if (okMatch) {
          pairsGenerated += parseInt(okMatch[2], 10);
        }
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      console.error('[TrainingQueueWorker stderr]', chunk.toString());
    });

    proc.on('close', (code: number | null) => {
      if (code === 0) {
        resolve(pairsGenerated);
      } else {
        reject(new Error(`documents_processor.py exited with code ${ code }`));
      }
    });

    proc.on('error', (err: Error) => {
      reject(err);
    });
  });
}
