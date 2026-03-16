/**
 * TrainingDataPreprocessor — converts conversation session files into
 * the training JSONL format expected by train_nightly.py.
 *
 * TrainingDataLogger writes one message per line to ~/sulla/conversations/[sessionId].jsonl.
 * train_nightly.py expects {"messages": [...]} per line in ~/sulla/training/.
 *
 * This module reads each session file from ~/sulla/conversations/, groups its
 * individual message lines into a single {"messages": [...]} conversation object,
 * writes them to ~/sulla/training/, and moves processed session files to
 * ~/sulla/conversations/processed/.
 */

import fs from 'node:fs';
import path from 'node:path';

import { resolveSullaConversationsDir, resolveSullaTrainingDir } from '../utils/sullaPaths';

/** Valid message roles for SFT training (OpenAI chat format). */
const VALID_ROLES = new Set(['system', 'user', 'assistant', 'tool']);

/**
 * Clean a raw TrainingMessage for SFT training.
 * Keeps role, content, tool_calls, tool_call_id.
 * Strips internal metadata (reasoning, nodeId, __toolRuns, etc.).
 * Returns null if the message has an invalid role.
 */
function cleanMessage(msg: Record<string, unknown>): Record<string, unknown> | null {
  const role = msg.role as string;

  // Skip messages with invalid roles (e.g. 'function', custom roles)
  if (!role || !VALID_ROLES.has(role)) {
    return null;
  }

  const clean: Record<string, unknown> = { role };

  if (msg.content !== undefined && msg.content !== null) {
    // Ensure content is a string (some providers return arrays)
    if (typeof msg.content === 'string') {
      clean.content = msg.content;
    } else if (Array.isArray(msg.content)) {
      const textParts = (msg.content)
        .filter((p: any) => typeof p === 'string' || p?.type === 'text')
        .map((p: any) => typeof p === 'string' ? p : p?.text ?? '');
      clean.content = textParts.join('\n');
    } else {
      clean.content = String(msg.content);
    }
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
  /** Number of conversations written to training dir */
  conversations:  number;
  /** Number of session files processed (including skipped) */
  filesProcessed: number;
  /** Number of session files skipped (empty or no user+assistant pair) */
  filesSkipped:   number;
}

/**
 * Preprocess conversation session files into training JSONL format.
 *
 * Reads:  ~/sulla/conversations/*.jsonl
 * Writes: ~/sulla/training/sessions-preprocessed-YYYY-MM-DD.jsonl
 * Moves:  processed files to ~/sulla/conversations/processed/
 *
 * @param logPath  Optional path to a log file for progress messages.
 * @returns Summary of what was preprocessed.
 */
export function preprocessTrainingData(logPath?: string): PreprocessResult {
  const result: PreprocessResult = { conversations: 0, filesProcessed: 0, filesSkipped: 0 };

  const conversationsDir = resolveSullaConversationsDir();
  if (!fs.existsSync(conversationsDir)) return result;

  const trainingDir = resolveSullaTrainingDir();
  const processedDir = path.join(conversationsDir, 'processed');
  fs.mkdirSync(trainingDir, { recursive: true });
  fs.mkdirSync(processedDir, { recursive: true });

  // Find .jsonl session files in the conversations dir root (not in processed/)
  const sessionFiles = fs.readdirSync(conversationsDir)
    .filter(f => f.endsWith('.jsonl'));

  if (sessionFiles.length === 0) return result;

  const log = (msg: string) => {
    if (logPath) {
      try { fs.appendFileSync(logPath, msg + '\n', 'utf-8') } catch { /* best-effort */ }
    }
  };

  log(`[preprocess] Found ${ sessionFiles.length } conversation file(s) in ${ conversationsDir }`);

  const outputFile = path.join(
    trainingDir,
    `sessions-preprocessed-${ new Date().toISOString().slice(0, 10) }.jsonl`,
  );

  for (const filename of sessionFiles) {
    const filePath = path.join(conversationsDir, filename);
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

    // Clean messages (filter out nulls from invalid roles) and write as {"messages": [...]}
    const cleanMessages = messages.map(cleanMessage).filter((m): m is Record<string, unknown> => m !== null);
    if (cleanMessages.length === 0) {
      log(`[preprocess] ${ filename }: all messages filtered out after cleaning, skipping`);
      moveToProcessed(filePath, processedDir, filename);
      result.filesSkipped++;
      continue;
    }
    const entry = JSON.stringify({ messages: cleanMessages });

    try {
      fs.appendFileSync(outputFile, entry + '\n', 'utf-8');
      result.conversations++;
      log(`[preprocess] ${ filename }: ${ messages.length } messages → training`);
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
