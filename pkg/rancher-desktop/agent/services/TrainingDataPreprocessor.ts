/**
 * TrainingDataPreprocessor — converts TrainingDataLogger session files into
 * the feedback_queue format expected by train_nightly.py.
 *
 * TrainingDataLogger writes one message per line to ~/sulla/training/[sessionId].jsonl.
 * train_nightly.py expects {"messages": [...]} per line in llm/feedback_queue/.
 *
 * This module reads each session file, groups its individual message lines into
 * a single {"messages": [...]} conversation object, writes them to the feedback_queue,
 * and moves processed session files to a processed/ subdirectory.
 */

import fs from 'node:fs';
import path from 'node:path';

import { resolveSullaTrainingDir } from '../utils/sullaPaths';

/**
 * Resolve the feedback_queue directory under the app's userData/llm/ path.
 */
function getFeedbackQueueDir(): string {
  try {
    const { app } = require('electron');
    return path.join(app.getPath('userData'), 'llm', 'feedback_queue');
  } catch {
    return path.join(process.cwd(), 'llm', 'feedback_queue');
  }
}

/**
 * Clean a raw TrainingMessage for SFT training.
 * Keeps role, content, tool_calls, tool_call_id.
 * Strips internal metadata (reasoning, nodeId, __toolRuns, etc.).
 */
function cleanMessage(msg: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = { role: msg.role };

  if (msg.content !== undefined && msg.content !== null) {
    clean.content = msg.content;
  }
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
    clean.tool_calls = msg.tool_calls;
  }
  if (msg.tool_call_id) {
    clean.tool_call_id = msg.tool_call_id;
  }

  return clean;
}

export interface PreprocessResult {
  /** Number of conversations written to the feedback queue */
  conversations: number;
  /** Number of session files processed (including skipped) */
  filesProcessed: number;
  /** Number of session files skipped (empty or no user+assistant pair) */
  filesSkipped: number;
}

/**
 * Preprocess TrainingDataLogger session files into feedback_queue format.
 *
 * @param logPath  Optional path to a log file for progress messages.
 * @returns Summary of what was preprocessed.
 */
export function preprocessTrainingData(logPath?: string): PreprocessResult {
  const result: PreprocessResult = { conversations: 0, filesProcessed: 0, filesSkipped: 0 };

  const sullaTrainingDir = resolveSullaTrainingDir();
  if (!fs.existsSync(sullaTrainingDir)) return result;

  const feedbackQueueDir = getFeedbackQueueDir();
  const processedDir = path.join(sullaTrainingDir, 'processed');
  fs.mkdirSync(feedbackQueueDir, { recursive: true });
  fs.mkdirSync(processedDir, { recursive: true });

  // Find .jsonl session files in the training dir root (not in processed/)
  const sessionFiles = fs.readdirSync(sullaTrainingDir)
    .filter(f => f.endsWith('.jsonl'));

  if (sessionFiles.length === 0) return result;

  const log = (msg: string) => {
    if (logPath) {
      try { fs.appendFileSync(logPath, msg + '\n', 'utf-8'); } catch { /* best-effort */ }
    }
  };

  const outputFile = path.join(
    feedbackQueueDir,
    `sessions-preprocessed-${ new Date().toISOString().slice(0, 10) }.jsonl`,
  );

  for (const filename of sessionFiles) {
    const filePath = path.join(sullaTrainingDir, filename);
    result.filesProcessed++;

    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8').trim();
    } catch {
      log(`[preprocess] Failed to read ${ filename }, skipping`);
      result.filesSkipped++;
      continue;
    }

    if (!content) {
      moveToProcessed(filePath, processedDir, filename);
      result.filesSkipped++;
      continue;
    }

    // Parse individual message lines
    const messages: Record<string, unknown>[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        messages.push(JSON.parse(trimmed));
      } catch {
        // Skip malformed lines
      }
    }

    // Need at least a user + assistant pair to be useful training data
    const hasUser = messages.some((m: any) => m.role === 'user');
    const hasAssistant = messages.some((m: any) => m.role === 'assistant');
    if (!hasUser || !hasAssistant) {
      log(`[preprocess] ${ filename }: no user+assistant pair, skipping`);
      moveToProcessed(filePath, processedDir, filename);
      result.filesSkipped++;
      continue;
    }

    // Clean messages and write as {"messages": [...]}
    const cleanMessages = messages.map(cleanMessage);
    const entry = JSON.stringify({ messages: cleanMessages });

    try {
      fs.appendFileSync(outputFile, entry + '\n', 'utf-8');
      result.conversations++;
    } catch (err) {
      log(`[preprocess] Failed to write entry for ${ filename }: ${ err }`);
      continue;
    }

    moveToProcessed(filePath, processedDir, filename);
  }

  log(`[preprocess] Preprocessed ${ result.conversations } conversation(s) from ${ result.filesProcessed } file(s)`);
  return result;
}

/** Move a file to the processed/ directory (with cross-device fallback). */
function moveToProcessed(filePath: string, processedDir: string, filename: string): void {
  const dest = path.join(processedDir, filename);
  try {
    fs.renameSync(filePath, dest);
  } catch {
    try {
      fs.copyFileSync(filePath, dest);
      fs.unlinkSync(filePath);
    } catch { /* best-effort */ }
  }
}
