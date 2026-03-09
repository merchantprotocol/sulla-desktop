/**
 * TrainingController — business logic for training IPC handlers.
 *
 * sullaEvents.ts contains thin `ipcMainProxy.handle(...)` calls that
 * delegate to the exported functions here.
 *
 * ## Architecture: Many Paths In, One Path Out
 *
 * There are MANY ways to create training data (each in its own module):
 *
 *   - **Conversations** (TrainingDataLogger → TrainingDataPreprocessor)
 *     ~/sulla/conversations/*.jsonl → ~/sulla/training/sessions-preprocessed-*.jsonl
 *
 *   - **Documents** (documents_processor.py)
 *     User-selected docs → <llm-root>/training/documents_knowledge.jsonl
 *
 *   - **Skills** (future)
 *   - **Manual uploads** (future)
 *
 * But there is ONE path to training:
 *
 *   ~/sulla/training/*.jsonl → train_nightly.py → LoRA → GGUF → models/
 *
 * train_nightly.py reads ALL *.jsonl from ~/sulla/training/, combines with
 * a replay buffer, and trains a LoRA adapter. On macOS it uses MLX; on
 * Linux/Windows it uses Unsloth + CUDA.
 *
 * ## Training Triggers
 *
 * 1. **runTraining()** — "Full Training Run" from training settings page.
 *    Allows toggling document processing, LoRA training, and skills.
 *    Spawns train_nightly.py directly via runPhase().
 *
 * 2. **trainConversationsNow()** — "Train Now" button (quick training).
 *    Preprocesses conversations, then delegates to
 *    LlamaCppService.runFullNightlyTraining() which runs
 *    documents_processor.py then train_nightly.py.
 *
 * Both flows acquire a file-based lock, create a timestamped log in
 * ~/sulla/logs/, run training asynchronously, and send progress via IPC.
 *
 * ## Related Files
 *
 * Training data creation (paths IN):
 *   - TrainingDataLogger.ts       — captures conversations → ~/sulla/conversations/
 *   - TrainingDataPreprocessor.ts  — converts conversations → ~/sulla/training/
 *   - documents_processor.py       — converts documents → training QA pairs
 *
 * Training execution (path OUT):
 *   - train_nightly.py             — reads ~/sulla/training/ → LoRA → GGUF
 *   - LlamaCppService.ts           — orchestrates script execution
 */

import * as fs from 'fs';
import * as path from 'path';
import * as window from '@pkg/window';
import Logging from '@pkg/utils/logging';

const console = Logging.background;

// ─── Training lock (file + in-memory) ────────────────────────────────
//
// Uses both an in-memory flag (`isTrainingRunning`) and a file-based lock
// (`<llm-root>/training/.training.lock`) so that:
// - The in-memory flag catches same-process duplicate calls instantly.
// - The file lock survives app restarts (e.g. crash during training).
// - The lock file contains { pid, startedAt } so stale locks can be
//   detected (if the PID is no longer alive, the lock is released).

/** Reference to the currently-running training child process, for cleanup/kill. */
let activeTrainingProcess: ReturnType<typeof import('child_process').spawn> | null = null;

/** In-memory flag — faster than checking the lock file on every call. */
let isTrainingRunning = false;

/** Last progress update sent to the renderer (survives page navigation). */
let lastProgressUpdate: { phase: string; progress: number; logFilename: string; iter?: number; totalIters?: number; eta?: string } | null = null;

/** Returns the ~/sulla/logs/ directory path. */
export function getTrainingLogsDir(): string {
  const os = require('os');
  return path.join(os.homedir(), 'sulla', 'logs');
}

/** Returns the path to the file-based training lock. */
function getTrainingLockFile(): string {
  try {
    const { app } = require('electron');
    return path.join(app.getPath('userData'), 'llm', 'training', '.training.lock');
  } catch {
    return path.join(process.cwd(), 'llm', 'training', '.training.lock');
  }
}

/** Write a lock file and set the in-memory flag. */
export function acquireTrainingLock(logFilename?: string): void {
  const lockFile = getTrainingLockFile();
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), logFilename: logFilename || '' }), 'utf-8');
  isTrainingRunning = true;
}

/** Remove the lock file and clear the in-memory flag. */
export function releaseTrainingLock(): void {
  isTrainingRunning = false;
  lastProgressUpdate = null;
  try { fs.unlinkSync(getTrainingLockFile()); } catch { /* already gone */ }
}

/**
 * Check if training is currently running.
 * First checks the in-memory flag, then falls back to the lock file.
 * If the lock file exists but the PID is dead, cleans up the stale lock.
 */
export function isTrainingLocked(): boolean {
  if (isTrainingRunning) return true;
  const lockFile = getTrainingLockFile();
  if (!fs.existsSync(lockFile)) return false;
  try {
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf-8'));
    process.kill(lock.pid, 0); // signal 0 = check if process exists
    return true;
  } catch {
    // PID is dead — stale lock
    try { fs.unlinkSync(lockFile); } catch { /* ignore */ }
    return false;
  }
}

// ─── Log helpers ──────────────────────────────────────────────────────

/**
 * Create a new timestamped log file in ~/sulla/logs/.
 * @param prefix  Log filename prefix (e.g. 'training', 'install')
 * @param headerLines  Lines to write at the top of the log file
 * @returns The log filename and full path
 */
function createLogFile(prefix: string, headerLines: string[]): { logFilename: string; logPath: string } {
  const logsDir = getTrainingLogsDir();
  fs.mkdirSync(logsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logFilename = `${prefix}-${timestamp}.log`;
  const logPath = path.join(logsDir, logFilename);
  fs.writeFileSync(logPath, headerLines.join('\n') + '\n', 'utf-8');
  return { logFilename, logPath };
}

/** Append a line to a log file (best-effort, never throws). */
function appendLog(logPath: string, msg: string): void {
  try { fs.appendFileSync(logPath, msg + '\n', 'utf-8'); } catch { /* ok */ }
}

/** Send a progress update to the renderer via IPC and also log it. */
function sendProgress(logFilename: string, logPath: string, phase: string, progress: number, extra?: { iter?: number; totalIters?: number; eta?: string }): void {
  appendLog(logPath, `[progress] ${phase} (${progress}%)`);
  const payload = { phase, progress, logFilename, ...extra };
  lastProgressUpdate = payload;
  try {
    window.send('training-run-progress' as any, payload);
  } catch { /* best-effort */ }
}

// ─── Training status / history / log-read ────────────────────────────

/** Returns whether training is currently running, the active log filename, and last progress. */
export function getTrainingStatus(): { running: boolean; logFilename: string; phase: string; progress: number; iter?: number; totalIters?: number; eta?: string } {
  const running = isTrainingLocked();
  let logFilename = '';

  if (running) {
    try {
      const lock = JSON.parse(fs.readFileSync(getTrainingLockFile(), 'utf-8'));
      logFilename = lock.logFilename || '';
    } catch { /* ok */ }

    // Fallback: if lock doesn't have logFilename, find the most recent log
    if (!logFilename) {
      const logsDir = getTrainingLogsDir();
      try {
        const files = fs.readdirSync(logsDir)
          .filter(f => f.startsWith('training-') && f.endsWith('.log'))
          .sort()
          .reverse();
        if (files.length > 0) logFilename = files[0];
      } catch { /* ok */ }
    }

    // Return cached progress so the renderer can restore state after navigation
    if (lastProgressUpdate) {
      return {
        running,
        logFilename,
        phase:      lastProgressUpdate.phase,
        progress:   lastProgressUpdate.progress,
        iter:       lastProgressUpdate.iter,
        totalIters: lastProgressUpdate.totalIters,
        eta:        lastProgressUpdate.eta,
      };
    }
  } else {
    // Training finished — clear cached progress
    lastProgressUpdate = null;
  }

  return { running, logFilename, phase: '', progress: 0 };
}

/**
 * Read all training log files from ~/sulla/logs/ and return metadata.
 * Parses each log to extract model, duration, status, and conversation count.
 */
export function getTrainingHistory() {
  const logsDir = getTrainingLogsDir();
  if (!fs.existsSync(logsDir)) return [];

  const files = fs.readdirSync(logsDir)
    .filter(f => f.startsWith('training-') && f.endsWith('.log'))
    .sort()
    .reverse();

  return files.map(filename => {
    const filePath = path.join(logsDir, filename);
    const stat = fs.statSync(filePath);

    let model: string | undefined;
    let durationMs: number | undefined;
    let conversationsProcessed: number | undefined;
    let status: 'completed' | 'running' | 'failed' = 'running';

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const modelMatch = content.match(/Model:\s+(.+)/);
      if (modelMatch) model = modelMatch[1].trim();

      if (content.includes('=== Completed:')) {
        status = 'completed';
        const startMatch = content.match(/Started:\s+(.+)/);
        const endMatch = content.match(/=== Completed:\s+(.+?)\s*(?:\(|===)/);
        if (startMatch && endMatch) {
          const startTime = new Date(startMatch[1].trim()).getTime();
          const endTime = new Date(endMatch[1].trim()).getTime();
          if (!isNaN(startTime) && !isNaN(endTime)) durationMs = endTime - startTime;
        }
      } else if (content.includes('FAILED')) {
        status = 'failed';
      } else {
        // If the log is older than 3 hours and never completed, it's failed
        const ageMs = Date.now() - stat.mtime.getTime();
        if (ageMs > 3 * 60 * 60 * 1000) status = 'failed';
      }

      const countMatch = content.match(/(\d+)\s+conversation/i);
      if (countMatch) conversationsProcessed = parseInt(countMatch[1], 10);
    } catch { /* ok */ }

    return {
      filename, size: stat.size,
      createdAt: stat.birthtime.toISOString(),
      modifiedAt: stat.mtime.toISOString(),
      model, durationMs, conversationsProcessed, status,
    };
  });
}

/** Read a specific training log file by filename. Rejects path traversal attempts. */
export function readTrainingLog(filename: string): string {
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    throw new Error('Invalid filename');
  }
  const filePath = path.join(getTrainingLogsDir(), filename);
  if (!fs.existsSync(filePath)) throw new Error(`Log file not found: ${filename}`);
  return fs.readFileSync(filePath, 'utf-8');
}

// ─── runTraining — full training run with source toggles ─────────────
//
// Called from the training settings page where the user can toggle
// Document Processing, LoRA Training, and Skills independently.
//
// This function spawns train_nightly.py DIRECTLY via runPhase(),
// NOT through LlamaCppService.runFullNightlyTraining().

/** Regex to match [PROGRESS] lines emitted by train_nightly.py */
const PROGRESS_RE = /\[PROGRESS\]\s+phase=(\S+)\s+iter=(\d+)\s+total=(\d+)\s+pct=(\d+)(?:\s+eta=(\S+))?/;

/** Map training phases to human-readable labels for UI display */
const PHASE_LABELS: Record<string, string> = {
  training: 'LoRA Training',
  fusing:   'Exporting GGUF',
  copying:  'Copying model',
  complete: 'Complete',
};

/**
 * Spawn a Python script as a child process and stream its output to a log file.
 * Parses [PROGRESS] lines from stdout and sends real-time progress updates
 * to the renderer via IPC ('training-run-progress').
 *
 * @param python       Path to the Python binary in the training venv
 * @param logPath      Path to the log file to stream output to
 * @param label        Human-readable label for this phase (e.g. "LoRA Training")
 * @param script       Path to the Python script to run
 * @param args         Arguments to pass to the script
 * @param timeoutMs    Maximum runtime before killing the process (default: 2 hours)
 * @param logFilename  Log filename for IPC progress events (optional)
 */
function runPhase(
  python: string,
  logPath: string,
  label: string,
  script: string,
  args: string[],
  timeoutMs = 7_200_000,
  logFilename?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    appendLog(logPath, `\n--- ${label} ---`);
    appendLog(logPath, `[${label}] Command: ${python} ${script} ${args.join(' ')}`);

    const proc = require('child_process').spawn(python, [script, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
      detached: process.platform !== 'win32',
    });
    activeTrainingProcess = proc;
    let settled = false;

    // Buffer partial lines from stdout for reliable [PROGRESS] parsing
    let stdoutBuffer = '';

    appendLog(logPath, `[${label}] Spawned PID ${proc.pid}`);

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      appendLog(logPath, `\n[${label}] TIMEOUT: exceeded ${Math.round(timeoutMs / 60000)} minutes`);
      try {
        if (process.platform === 'win32') {
          require('child_process').execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'pipe' });
        } else if (proc.pid) {
          process.kill(-proc.pid, 'SIGKILL');
        }
      } catch { /* dead */ }
      activeTrainingProcess = null;
      reject(new Error(`${label} timed out`));
    }, timeoutMs);

    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      try { fs.appendFileSync(logPath, text); } catch { /* ok */ }

      // Parse [PROGRESS] lines for IPC forwarding
      if (logFilename) {
        stdoutBuffer += text;
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() || ''; // keep incomplete last line in buffer
        for (const line of lines) {
          const m = PROGRESS_RE.exec(line);
          if (m) {
            const [, phase, iter, total, pct, eta] = m;
            const phaseLabel = PHASE_LABELS[phase] || phase;
            const etaStr = eta && eta !== 'calculating...' ? ` — ${eta} remaining` : '';
            const progressStr = `${phaseLabel}: ${iter}/${total} (${pct}%)${etaStr}`;
            // Map training progress to 30-95% range (30% = start, 95% = training done)
            const overallPct = phase === 'complete' ? 100
              : phase === 'training' ? 30 + Math.round(parseInt(pct) * 0.65)
              : phase === 'fusing' ? 95 + Math.round(parseInt(pct) * 0.04)
              : 99;
            const payload = {
              phase:       progressStr,
              progress:    overallPct,
              logFilename,
              iter:        parseInt(iter),
              totalIters:  parseInt(total),
              eta:         eta || '',
            };
            lastProgressUpdate = payload;
            try {
              window.send('training-run-progress' as any, payload);
            } catch { /* best-effort */ }
          }
        }
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      try { fs.appendFileSync(logPath, chunk); } catch { /* ok */ }
    });
    proc.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      activeTrainingProcess = null;
      if (code === 0) {
        appendLog(logPath, `[${label}] Completed (exit 0)`);
        resolve();
      } else {
        appendLog(logPath, `[${label}] Failed (exit ${code})`);
        reject(new Error(`${label} failed (exit ${code})`));
      }
    });
    proc.on('error', (err: Error) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      activeTrainingProcess = null;
      appendLog(logPath, `[${label}] Process error: ${err.message}`);
      reject(err);
    });
  });
}

/**
 * Full training run with source toggles (Document Processing, LoRA, Skills).
 *
 * Flow:
 *   1. Preprocess conversation sessions → ~/sulla/training/*.jsonl
 *   2. (optional) Run documents_processor.py
 *   3. (optional) Run train_nightly.py --training-dir ~/sulla/training/
 *   4. (optional) Skills training (placeholder)
 *
 * Called by IPC handler 'training-run'.
 */
export async function runTraining(
  modelKey: string,
  sources: { documentProcessing: boolean; loraTraining: boolean; skills: boolean },
): Promise<{ logFilename: string; logPath: string }> {
  if (isTrainingLocked()) throw new Error('A training run is already in progress');

  const { getLlamaCppService, GGUF_MODELS, getTrainingScriptsDir } = await import('@pkg/agent/services/LlamaCppService');
  const service = getLlamaCppService();
  const entry = GGUF_MODELS[modelKey];
  if (!entry?.trainingRepo) throw new Error(`Model ${modelKey} has no training repo configured`);

  const { app } = require('electron');
  const llmRoot = path.join(app.getPath('userData'), 'llm');

  const enabledSources: string[] = [];
  if (sources.documentProcessing) enabledSources.push('Document Processing');
  if (sources.loraTraining) enabledSources.push('LoRA Training');
  if (sources.skills) enabledSources.push('Skills');

  const { logFilename, logPath } = createLogFile('training', [
    '=== Sulla Training Run ===',
    `Started: ${new Date().toISOString()}`,
    `Model: ${modelKey} (${entry.trainingRepo})`,
    `Sources: ${enabledSources.join(', ') || 'none'}`,
    `LLM Root: ${llmRoot}`,
    '',
  ]);

  acquireTrainingLock(logFilename);

  (async () => {
    try {
      const python = service.getTrainingPython();
      if (!python) {
        appendLog(logPath, '\n[ERROR] Training environment not installed.');
        return;
      }
      appendLog(logPath, `Python: ${python}`);

      const scriptsDir = getTrainingScriptsDir();
      const trainScript = path.join(scriptsDir, 'train_nightly.py');
      const docScript = path.join(scriptsDir, 'documents_processor.py');

      appendLog(logPath, `Scripts dir: ${scriptsDir}`);
      appendLog(logPath, `train_nightly.py exists: ${fs.existsSync(trainScript)}`);
      appendLog(logPath, `documents_processor.py exists: ${fs.existsSync(docScript)}`);

      // Phase 0: Preprocess conversation sessions into training JSONL
      appendLog(logPath, '\n--- Session Preprocessing ---');
      try {
        const { preprocessTrainingData } = await import('@pkg/agent/services/TrainingDataPreprocessor');
        const result = preprocessTrainingData(logPath);
        appendLog(logPath, `[preprocess] ${result.conversations} conversation(s) from ${result.filesProcessed} file(s) (${result.filesSkipped} skipped)`);
      } catch (err) {
        appendLog(logPath, `[preprocess] Failed: ${err}`);
      }

      // Phase 1: Document Processing (optional)
      if (sources.documentProcessing) {
        try {
          await runPhase(python, logPath, 'Documents Processing', docScript, ['--llm-root', llmRoot], 600_000, logFilename);
        } catch {
          appendLog(logPath, 'Document processing failed, continuing...');
        }
      } else {
        appendLog(logPath, '[Skipped] Document Processing');
      }

      // Phase 2: LoRA Training (optional)
      if (sources.loraTraining) {
        const { resolveSullaTrainingDir } = await import('@pkg/agent/utils/sullaPaths');
        const trainingDir = resolveSullaTrainingDir();
        appendLog(logPath, `[LoRA] Training data dir: ${trainingDir}`);
        try {
          await runPhase(python, logPath, 'LoRA Training', trainScript,
            ['--model', entry.trainingRepo!, '--llm-root', llmRoot, '--training-dir', trainingDir],
            7_200_000, logFilename);
        } catch { /* logged by runPhase */ }
      } else {
        appendLog(logPath, '[Skipped] LoRA Training');
      }

      // Phase 3: Skills (placeholder)
      if (sources.skills) {
        appendLog(logPath, '\n--- Skills Training ---\n[Skills] Not yet implemented.');
      }

      appendLog(logPath, `\n=== Completed: ${new Date().toISOString()} ===`);
    } catch (err) {
      appendLog(logPath, `\n[ERROR] ${err}`);
    } finally {
      releaseTrainingLock();
      appendLog(logPath, `\n=== Training Run Finished: ${new Date().toISOString()} ===`);
    }
  })().catch(() => releaseTrainingLock());

  return { logFilename, logPath };
}

// ─── trainConversationsNow — quick "Train Now" button ────────────────
//
// This is the primary "Train Now" flow triggered by the UI button.
// It does NOT spawn train_nightly.py directly. Instead it delegates
// to LlamaCppService.runFullNightlyTraining() which handles both
// document processing and training script execution.
//
// Flow:
//   1. Preprocess conversations (TrainingDataPreprocessor)
//   2. Drain document queue (TrainingQueueWorker)
//   3. LlamaCppService.runFullNightlyTraining():
//      a) documents_processor.py --llm-root <llm-root>
//      b) train_nightly.py --model <repo> --llm-root <llm-root> --training-dir ~/sulla/training/

/**
 * Quick training triggered by "Train Now" button.
 *
 * Steps:
 *   1. Preprocess ~/sulla/conversations/*.jsonl → ~/sulla/training/*.jsonl
 *   2. Drain document processing queue (if any pending jobs)
 *   3. Call LlamaCppService.runFullNightlyTraining() which runs:
 *      - documents_processor.py (incremental doc scan)
 *      - train_nightly.py --training-dir ~/sulla/training/
 *
 * Returns immediately with { logFilename, logPath }. Training runs
 * in the background. Progress is sent via 'training-run-progress' IPC.
 */
export async function trainConversationsNow(): Promise<{ logFilename: string; logPath: string }> {
  const log = (msg: string, logPath?: string) => {
    console.log(`[TrainConvNow] ${msg}`);
    if (logPath) appendLog(logPath, `[TrainConvNow] ${msg}`);
  };

  log('Handler invoked');
  if (isTrainingLocked()) {
    log('BLOCKED: training lock is held');
    throw new Error('A training run is already in progress');
  }

  // 1. Preprocess conversation session files → training JSONL
  log('Step 1: Preprocessing session files...');
  const { preprocessTrainingData } = await import('@pkg/agent/services/TrainingDataPreprocessor');
  const preprocessResult = preprocessTrainingData();
  log(`Step 1 done: ${preprocessResult.conversations} conversation(s) from ${preprocessResult.filesProcessed} file(s), ${preprocessResult.filesSkipped} skipped`);

  // 2. Resolve model config from settings
  log('Step 2: Loading model config...');
  const { SullaSettingsModel } = await import('@pkg/agent/database/models/SullaSettingsModel');
  const modelKey = await SullaSettingsModel.get('sullaModel', 'qwen3.5-9b');
  log(`Step 2 done: modelKey="${modelKey}"`);

  // 3. Validate model and training environment
  log('Step 3: Validating model and training env...');
  const { GGUF_MODELS, getLlamaCppService, getTrainingScriptsDir } = await import('@pkg/agent/services/LlamaCppService');
  const entry = GGUF_MODELS[modelKey];
  log(`Step 3a: GGUF_MODELS[${modelKey}] = ${JSON.stringify({ trainingRepo: entry?.trainingRepo, hasEntry: !!entry })}`);
  if (!entry?.trainingRepo) throw new Error(`Model ${modelKey} has no training repo configured`);

  const service = getLlamaCppService();
  const python = service.getTrainingPython();
  log(`Step 3b: trainingPython = "${python || 'NOT FOUND'}"`);
  if (!python) throw new Error('Training environment not installed');

  const scriptsDir = getTrainingScriptsDir();
  log(`Step 3c: scriptsDir="${scriptsDir}"`);
  log(`Step 3d: train_nightly.py exists = ${fs.existsSync(path.join(scriptsDir, 'train_nightly.py'))}`);

  // 3e. Verify training data directory has files
  const { resolveSullaTrainingDir } = await import('@pkg/agent/utils/sullaPaths');
  const trainingDir = resolveSullaTrainingDir();
  const trainingFiles = fs.existsSync(trainingDir)
    ? fs.readdirSync(trainingDir).filter(f => f.endsWith('.jsonl'))
    : [];
  log(`Step 3e: trainingDir="${trainingDir}", files=${JSON.stringify(trainingFiles)}`);

  // 4. Create log file
  const { logFilename, logPath } = createLogFile('training', [
    '=== Train on Conversations (Manual) ===',
    `Started: ${new Date().toISOString()}`,
    `Model: ${modelKey} (repo: ${entry.trainingRepo})`,
    `Python: ${python}`,
    `Scripts dir: ${scriptsDir}`,
    `Training dir: ${trainingDir}`,
    `Training files: ${trainingFiles.join(', ') || '(none)'}`,
    `Conversations preprocessed: ${preprocessResult.conversations}`,
    `Files processed: ${preprocessResult.filesProcessed}, skipped: ${preprocessResult.filesSkipped}`,
    '',
  ]);
  log(`Step 4 done: logFile="${logPath}"`);

  // 5. Run training asynchronously
  acquireTrainingLock(logFilename);
  log('Training lock acquired', logPath);

  sendProgress(logFilename, logPath, 'Preprocessing conversations', 10);

  (async () => {
    try {
      // 5a. Drain document queue (if any pending jobs)
      try {
        sendProgress(logFilename, logPath, 'Checking document queue', 15);
        const { processQueue, getQueueLength } = await import('@pkg/agent/services/TrainingQueueWorker');
        const pending = await getQueueLength();
        log(`Document queue: ${pending} pending job(s)`, logPath);
        if (pending > 0) {
          sendProgress(logFilename, logPath, `Processing ${pending} queued doc job(s)`, 20);
          await processQueue();
          log('Document queue drained', logPath);
        } else {
          log('Document queue empty, skipping', logPath);
        }
      } catch (qErr) {
        log(`WARNING: Document queue processing failed: ${qErr}`, logPath);
      }

      // 5b. Run full nightly training via LlamaCppService
      //     This calls: documents_processor.py, then train_nightly.py --training-dir
      sendProgress(logFilename, logPath, 'Starting LoRA training pipeline', 30);
      log(`Calling runFullNightlyTraining("${modelKey}", "${logPath}")...`, logPath);

      // Parse [PROGRESS] lines from train_nightly.py and forward as IPC events
      const onTrainingStdout = (line: string) => {
        const m = PROGRESS_RE.exec(line);
        if (!m) return;
        const [, phase, iter, total, pct, eta] = m;
        const phaseLabel = PHASE_LABELS[phase] || phase;
        const etaStr = eta && eta !== 'calculating...' ? ` — ${eta} remaining` : '';
        const progressStr = `${phaseLabel}: ${iter}/${total} (${pct}%)${etaStr}`;
        const overallPct = phase === 'complete' ? 100
          : phase === 'training' ? 30 + Math.round(parseInt(pct) * 0.65)
          : phase === 'fusing' ? 95 + Math.round(parseInt(pct) * 0.04)
          : 99;
        const payload = {
          phase:       progressStr,
          progress:    overallPct,
          logFilename,
          iter:        parseInt(iter),
          totalIters:  parseInt(total),
          eta:         eta || '',
        };
        lastProgressUpdate = payload;
        try {
          window.send('training-run-progress' as any, payload);
        } catch { /* best-effort */ }
      };

      const trainingStart = Date.now();
      await service.runFullNightlyTraining(modelKey, logPath, onTrainingStdout);
      const trainingDuration = Date.now() - trainingStart;

      log(`runFullNightlyTraining completed in ${trainingDuration}ms`, logPath);
      appendLog(logPath, `\n=== Completed: ${new Date().toISOString()} (${Math.round(trainingDuration / 1000)}s) ===`);
      sendProgress(logFilename, logPath, 'Complete', 100);
    } catch (err: any) {
      const errMsg = err?.stack || err?.message || String(err);
      log(`TRAINING FAILED: ${errMsg}`, logPath);
      appendLog(logPath, `\n=== FAILED ===\n${errMsg}`);
      sendProgress(logFilename, logPath, 'Failed', 100);
    } finally {
      releaseTrainingLock();
      log('Training lock released', logPath);
    }
  })();

  log(`Returning logFilename="${logFilename}" (training running in background)`);
  return { logFilename, logPath };
}

// ─── Schedule ────────────────────────────────────────────────────────

/** Timer handle for the next scheduled nightly training run. */
let nightlyTimer: ReturnType<typeof setTimeout> | null = null;

/** Interval handle for auto-preprocessing every hour. */
let autoPreprocessInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Schedule (or cancel) the next nightly training run.
 * Runs trainConversationsNow() at the specified hour:minute local time.
 * Reschedules itself for the next day after each run.
 */
export function rescheduleNightlyTraining(enabled: boolean, hour: number, minute: number): void {
  if (nightlyTimer) { clearTimeout(nightlyTimer); nightlyTimer = null; }
  if (!enabled) return;

  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);

  const delayMs = next.getTime() - now.getTime();
  console.log(`[Training] Next nightly run scheduled for ${next.toISOString()} (in ${Math.round(delayMs / 60000)}min)`);

  nightlyTimer = setTimeout(async () => {
    try {
      await trainConversationsNow();
    } catch (err) {
      console.error('[Training] Nightly training failed:', err);
    }
    rescheduleNightlyTraining(true, hour, minute);
  }, delayMs);
  nightlyTimer.unref();
}

/**
 * Start auto-preprocessing conversation sessions every hour.
 * This converts ~/sulla/conversations/*.jsonl → ~/sulla/training/*.jsonl
 * so data is ready when the nightly training job runs.
 */
export function startAutoPreprocessing(): void {
  if (autoPreprocessInterval) return;
  console.log('[Training] Starting auto-preprocessing (1hr interval)');
  autoPreprocessInterval = setInterval(async () => {
    try {
      const { preprocessTrainingData } = await import('@pkg/agent/services/TrainingDataPreprocessor');
      const result = preprocessTrainingData();
      if (result.conversations > 0) {
        console.log(`[Training] Auto-preprocessed ${result.conversations} conversation(s)`);
      }
    } catch (err) {
      console.error('[Training] Auto-preprocessing failed:', err);
    }
  }, 60 * 60 * 1000);
  autoPreprocessInterval.unref();
}

/** Stop the hourly auto-preprocessing interval. */
export function stopAutoPreprocessing(): void {
  if (autoPreprocessInterval) {
    clearInterval(autoPreprocessInterval);
    autoPreprocessInterval = null;
    console.log('[Training] Stopped auto-preprocessing');
  }
}

// ─── Scheduled configs ───────────────────────────────────────────────

const SCHEDULED_CONFIGS_KEY = 'training:scheduled_configs';

async function getSettingsModel() {
  const { SullaSettingsModel } = await import('@pkg/agent/database/models/SullaSettingsModel');
  return SullaSettingsModel;
}

async function loadConfigsArray(): Promise<any[]> {
  const Settings = await getSettingsModel();
  const raw = await Settings.get(SCHEDULED_CONFIGS_KEY, '[]');
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : []);
  } catch { return []; }
}

export async function listScheduledConfigs(): Promise<any[]> {
  return loadConfigsArray();
}

export async function addScheduledConfig(config: { name: string; source: string; modelKey: string; prompt?: string; outputFilename?: string; files?: string[] }): Promise<{ id: string }> {
  const Settings = await getSettingsModel();
  const configs = await loadConfigsArray();
  const id = `cfg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  configs.push({ ...config, id, createdAt: new Date().toISOString() });
  await Settings.set(SCHEDULED_CONFIGS_KEY, JSON.stringify(configs), 'string');
  return { id };
}

export async function removeScheduledConfig(id: string): Promise<{ ok: boolean }> {
  const Settings = await getSettingsModel();
  let configs = await loadConfigsArray();
  configs = configs.filter((c: any) => c.id !== id);
  await Settings.set(SCHEDULED_CONFIGS_KEY, JSON.stringify(configs), 'string');
  return { ok: true };
}

// ─── Wizard settings ─────────────────────────────────────────────────

/** Save wizard settings (create-model or train-model wizard) to the settings DB. */
export async function saveWizardSettings(wizard: 'create' | 'train', settings: Record<string, unknown>): Promise<{ ok: boolean }> {
  const Settings = await getSettingsModel();
  const prefix = `training:wizard:${wizard}`;
  for (const [key, value] of Object.entries(settings)) {
    const cast = Array.isArray(value) ? 'json' : typeof value === 'object' && value !== null ? 'json' : typeof value as string;
    await Settings.set(`${prefix}:${key}`, value, cast);
  }
  return { ok: true };
}

/** Load wizard settings from the settings DB. */
export async function loadWizardSettings(wizard: 'create' | 'train'): Promise<Record<string, unknown>> {
  const Settings = await getSettingsModel();
  const prefix = `training:wizard:${wizard}`;
  try {
    const all = await Settings.getByPattern(`${prefix}:*`);
    const result: Record<string, unknown> = {};
    for (const [fullKey, value] of Object.entries(all)) {
      result[fullKey.replace(`${prefix}:`, '')] = value;
    }
    return result;
  } catch { return {}; }
}

// ─── Install ─────────────────────────────────────────────────────────

/** In-memory flag — true while installTrainingEnv() is running. */
let isTrainingInstalling = false;

/** Last error message from a failed install attempt. */
let trainingInstallError = '';

/** Returns the current install state. */
export function getInstallStatus() {
  return { installing: isTrainingInstalling, error: trainingInstallError };
}

/**
 * Install the training environment (Python venv + deps + model download).
 * Runs asynchronously. Sends progress updates via 'training-install-progress' IPC.
 */
export async function installTrainingEnv(): Promise<{ logFilename: string }> {
  if (isTrainingInstalling) throw new Error('Training environment installation is already in progress');

  const { getLlamaCppService, GGUF_MODELS } = await import('@pkg/agent/services/LlamaCppService');
  const Settings = await getSettingsModel();
  const service = getLlamaCppService();
  const modelKey = await Settings.get('sullaModel', 'qwen3.5-9b');
  const entry = GGUF_MODELS[modelKey];
  if (!entry?.trainingRepo) throw new Error(`Model ${modelKey} has no training repo configured`);

  isTrainingInstalling = true;
  trainingInstallError = '';

  const { logFilename, logPath } = createLogFile('install', [
    '=== Training Environment Install ===',
    `Started: ${new Date().toISOString()}`,
    `Model: ${modelKey} (${entry.trainingRepo})`,
    '',
  ]);

  const sendInstallProgress = (data: { phase: string; description: string; current: number; max: number; fileName?: string; bytesReceived?: number; bytesTotal?: number }) => {
    window.send('training-install-progress' as any, data);
  };

  (async () => {
    try {
      sendInstallProgress({ phase: 'deps', description: 'Installing Python dependencies...', current: 0, max: 100 });
      await service.installTrainingDeps(logPath, (description, current, max) => {
        sendInstallProgress({ phase: 'deps', description, current, max });
      });

      service['writeDocumentsConfig']();

      sendInstallProgress({ phase: 'model', description: `Downloading training model ${entry.trainingRepo}...`, current: 0, max: 100 });
      await service.downloadTrainingModel(modelKey, logPath, (fileIndex, fileCount, fileName, bytesReceived, bytesTotal) => {
        const overallPct = Math.round(((fileIndex + bytesReceived / bytesTotal) / fileCount) * 100);
        sendInstallProgress({ phase: 'model', description: `Downloading ${fileName} (${fileIndex + 1}/${fileCount})`, current: overallPct, max: 100, fileName, bytesReceived, bytesTotal });
      });

      sendInstallProgress({ phase: 'done', description: 'Training environment installed successfully', current: 100, max: 100 });
      appendLog(logPath, `\n=== Install Complete: ${new Date().toISOString()} ===`);
    } catch (err: any) {
      trainingInstallError = err?.message || String(err);
      appendLog(logPath, `\n[ERROR] ${trainingInstallError}`);
      sendInstallProgress({ phase: 'error', description: trainingInstallError, current: 0, max: 100 });
    } finally {
      isTrainingInstalling = false;
    }
  })().catch(() => { isTrainingInstalling = false; });

  return { logFilename };
}

// ─── Queue ───────────────────────────────────────────────────────────

/** Enqueue files for document processing (converts docs → training JSONL via LLM). */
export async function addToQueue(entries: Array<{ filePath: string; prompt: string; modelId: string; modelProvider: string; outputFilename: string }>): Promise<{ queued: number }> {
  const { enqueueTrainingFiles } = await import('@pkg/agent/services/TrainingQueueWorker');
  const queueEntries = entries.map(e => ({
    filePath: e.filePath, prompt: e.prompt, modelId: e.modelId,
    modelProvider: e.modelProvider, outputFilename: e.outputFilename,
    queuedAt: new Date().toISOString(),
  }));
  const queued = await enqueueTrainingFiles(queueEntries);
  return { queued };
}

/** Start processing the document queue (non-blocking). */
export async function processQueueNow(): Promise<{ ok: boolean }> {
  const { processQueue, isQueueProcessing } = await import('@pkg/agent/services/TrainingQueueWorker');
  if (isQueueProcessing()) return { ok: false };
  processQueue((event) => {
    window.send('training-prepare-progress' as any, event);
  }).catch(err => console.error('[TrainingQueueWorker] Error:', err));
  return { ok: true };
}

/** Get the current document queue status. */
export async function getQueueStatus(): Promise<{ pending: number; processing: boolean }> {
  const { getQueueLength, isQueueProcessing } = await import('@pkg/agent/services/TrainingQueueWorker');
  return { pending: await getQueueLength(), processing: isQueueProcessing() };
}

// ─── Schedule get/set ────────────────────────────────────────────────

/** Load the nightly training schedule from settings DB. */
export async function getSchedule(): Promise<{ enabled: any; hour: any; minute: any }> {
  const Settings = await getSettingsModel();
  return {
    enabled: await Settings.get('trainingScheduleEnabled', false),
    hour:    await Settings.get('trainingScheduleHour', 2),
    minute:  await Settings.get('trainingScheduleMinute', 0),
  };
}

/** Save the nightly training schedule and immediately re-arm the timer. */
export async function setSchedule(opts: { enabled: boolean; hour: number; minute: number }): Promise<{ ok: boolean }> {
  const Settings = await getSettingsModel();
  await Settings.set('trainingScheduleEnabled', opts.enabled, 'boolean');
  await Settings.set('trainingScheduleHour', opts.hour, 'number');
  await Settings.set('trainingScheduleMinute', opts.minute, 'number');

  rescheduleNightlyTraining(opts.enabled, opts.hour, opts.minute);
  if (opts.enabled) startAutoPreprocessing();
  else stopAutoPreprocessing();

  return { ok: true };
}

/** Call on app startup to arm the schedule if previously enabled. */
export async function initScheduleOnStartup(): Promise<void> {
  try {
    const { enabled, hour, minute } = await getSchedule();
    if (enabled) {
      rescheduleNightlyTraining(true, hour, minute);
      startAutoPreprocessing();
    }
  } catch { /* settings DB may not be ready */ }
}

// ─── Models ──────────────────────────────────────────────────────────

/** Return the list of GGUF models that have both a training repo and a downloaded model file. */
export async function getDownloadedTrainingModels(): Promise<Array<{ key: string; displayName: string; trainingRepo: string }>> {
  const { GGUF_MODELS, getLlamaCppService } = await import('@pkg/agent/services/LlamaCppService');
  const svc = getLlamaCppService();
  const results: Array<{ key: string; displayName: string; trainingRepo: string }> = [];
  for (const [key, entry] of Object.entries(GGUF_MODELS)) {
    if (entry.trainingRepo && svc.getModelPath(key)) {
      results.push({ key, displayName: entry.displayName, trainingRepo: entry.trainingRepo });
    }
  }
  return results;
}

// ─── Preprocess ──────────────────────────────────────────────────────

/** Manually trigger conversation preprocessing (~/sulla/conversations/ → ~/sulla/training/). */
export async function preprocessNow() {
  const { preprocessTrainingData } = await import('@pkg/agent/services/TrainingDataPreprocessor');
  return preprocessTrainingData();
}

// ─── Document Config ─────────────────────────────────────────────────

/** File extensions supported by the document processor. */
const SUPPORTED_FILE_TYPES = ['.txt', '.md', '.pdf', '.docx'];

/** Path to the documents_config.json file (in <llm-root>/training/). */
function getDocsConfigPath(): string {
  try {
    const { app } = require('electron');
    return path.join(app.getPath('userData'), 'llm', 'training', 'documents_config.json');
  } catch {
    return path.join(process.cwd(), 'llm', 'training', 'documents_config.json');
  }
}

/** Resolve ~/sulla/ home directory (respects SULLA_HOME_DIR env var). */
function getSullaHomeDir(): string {
  const os = require('os');
  const envPath = String(process.env.SULLA_HOME_DIR || '').trim();
  if (envPath && path.isAbsolute(envPath)) return envPath;
  if (envPath) return path.resolve(envPath);
  return path.join(os.homedir(), 'sulla');
}

/** Check if documents_config.json exists. */
export function docsConfigExists(): boolean {
  return fs.existsSync(getDocsConfigPath());
}

/** Load the documents config (folders, files, file types to process). */
export function docsConfigLoad(): { folders: string[]; files: string[]; fileTypes: string[] } {
  const configPath = getDocsConfigPath();
  if (fs.existsSync(configPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      return {
        folders:   Array.isArray(raw.folders) ? raw.folders as string[] : [],
        files:     Array.isArray(raw.files) ? raw.files as string[] : [],
        fileTypes: Array.isArray(raw.file_types) ? raw.file_types as string[] : SUPPORTED_FILE_TYPES,
      };
    } catch { /* corrupted */ }
  }
  return { folders: [], files: [], fileTypes: SUPPORTED_FILE_TYPES };
}

/** Save the documents config (folders, files, file types to process). */
export function docsConfigSave(folders: string[], files: string[], fileTypes: string[]): { ok: boolean } {
  const configPath = getDocsConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const config = {
    folders,
    files,
    file_types: fileTypes && fileTypes.length > 0 ? fileTypes : SUPPORTED_FILE_TYPES,
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  console.log(`[Sulla] Saved documents_config.json with ${folders.length} folders, ${files.length} files`);
  return { ok: true };
}

/** List files and directories in a path, filtered to supported document types. */
export function docsListDir(dirPath: string) {
  const exts = new Set(SUPPORTED_FILE_TYPES);
  const results: Array<{ path: string; name: string; isDir: boolean; hasChildren: boolean; size: number; ext: string }> = [];

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        let hasChildren = false;
        try {
          const children = fs.readdirSync(fullPath, { withFileTypes: true });
          hasChildren = children.some(c => !c.name.startsWith('.') && (c.isDirectory() || (c.isFile() && exts.has(path.extname(c.name).toLowerCase()))));
        } catch { /* permission denied */ }
        results.push({ path: fullPath, name: entry.name, isDir: true, hasChildren, size: 0, ext: '' });
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (exts.has(ext)) {
          try {
            const stat = fs.statSync(fullPath);
            results.push({ path: fullPath, name: entry.name, isDir: false, hasChildren: false, size: stat.size, ext });
          } catch { /* skip unreadable */ }
        }
      }
    }
  } catch (err) {
    console.error('[Sulla] FAILED to list directory:', dirPath, err);
  }

  results.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return results;
}

/** List files and directories in a path (unfiltered, for the content tree browser). */
export function contentTree(dirPath?: string) {
  type TreeEntry = { path: string; name: string; isDir: boolean; hasChildren: boolean; size: number; ext: string; category?: string };
  const results: TreeEntry[] = [];
  const targetDir: string = dirPath || require('os').homedir();

  try {
    const entries = fs.readdirSync(targetDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(targetDir, entry.name);

      if (entry.isDirectory()) {
        let hasChildren = false;
        try {
          const children = fs.readdirSync(fullPath, { withFileTypes: true });
          hasChildren = children.some(c => !c.name.startsWith('.'));
        } catch { /* permission denied */ }
        results.push({ path: fullPath, name: entry.name, isDir: true, hasChildren, size: 0, ext: '' });
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        try {
          const stat = fs.statSync(fullPath);
          results.push({ path: fullPath, name: entry.name, isDir: false, hasChildren: false, size: stat.size, ext });
        } catch { /* skip unreadable */ }
      }
    }
  } catch (err) {
    console.error('[Sulla] FAILED to list content dir:', targetDir, err);
  }

  results.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return results;
}

// ─── Install Status (full) ───────────────────────────────────────────

/** Returns comprehensive install status including disk space estimates. */
export async function getFullInstallStatus() {
  const { getLlamaCppService, GGUF_MODELS } = await import('@pkg/agent/services/LlamaCppService');
  const Settings = await getSettingsModel();
  const service = getLlamaCppService();
  const modelKey = await Settings.get('sullaModel', 'qwen3.5-9b');

  const entry = GGUF_MODELS[modelKey];
  const hasPython = service.getTrainingPython() !== null;
  const hasModel = entry?.trainingRepo ? service.getTrainingModelPath(modelKey) !== null : false;
  const installed = hasPython && hasModel;

  const modelSizeBytes = entry?.sizeBytes ?? 0;
  const pythonDepsBytes = 2_000_000_000;
  const requiredBytes = modelSizeBytes + pythonDepsBytes;

  let availableBytes = 0;
  try {
    const { statfsSync } = await import('fs');
    const { app } = await import('electron');
    const stats = statfsSync(app.getPath('userData'));
    availableBytes = stats.bavail * stats.bsize;
  } catch {
    availableBytes = Number.MAX_SAFE_INTEGER;
  }

  return {
    installed,
    installing:   isTrainingInstalling,
    error:        trainingInstallError,
    modelKey,
    displayName:  entry?.displayName ?? modelKey,
    trainingRepo: entry?.trainingRepo ?? '',
    requiredBytes,
    availableBytes,
  };
}

// ─── Training Data Files ─────────────────────────────────────────────

/**
 * List training data files from multiple sources:
 * - ~/sulla/training/*.jsonl (session-preprocessed files)
 * - ~/sulla/training/processed/*.jsonl (already-consumed files)
 * - <llm-root>/training/*.jsonl (document knowledge files)
 */
export async function listTrainingDataFiles() {
  const results: Array<{ filename: string; path: string; size: number; modifiedAt: string; examples: number; source: 'sessions' | 'documents' | 'processed' }> = [];

  function countLines(filePath: string): number {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return content.split('\n').filter(l => l.trim().length > 0).length;
    } catch { return 0; }
  }

  try {
    const { resolveSullaTrainingDir } = await import('@pkg/agent/utils/sullaPaths');
    const dir = resolveSullaTrainingDir();

    if (fs.existsSync(dir)) {
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.jsonl')) continue;
        try {
          const fullPath = path.join(dir, name);
          const stat = fs.statSync(fullPath);
          results.push({ filename: name, path: fullPath, size: stat.size, modifiedAt: stat.mtime.toISOString(), examples: countLines(fullPath), source: 'sessions' });
        } catch { /* skip */ }
      }

      const processedDir = path.join(dir, 'processed');
      if (fs.existsSync(processedDir)) {
        for (const name of fs.readdirSync(processedDir)) {
          if (!name.endsWith('.jsonl')) continue;
          try {
            const fullPath = path.join(processedDir, name);
            const stat = fs.statSync(fullPath);
            results.push({ filename: name, path: fullPath, size: stat.size, modifiedAt: stat.mtime.toISOString(), examples: countLines(fullPath), source: 'processed' });
          } catch { /* skip */ }
        }
      }
    }

    const { app } = require('electron');
    const llmTrainingDir = path.join(app.getPath('userData'), 'llm', 'training');
    if (fs.existsSync(llmTrainingDir)) {
      for (const name of fs.readdirSync(llmTrainingDir)) {
        if (!name.endsWith('.jsonl')) continue;
        try {
          const fullPath = path.join(llmTrainingDir, name);
          const stat = fs.statSync(fullPath);
          results.push({ filename: name, path: fullPath, size: stat.size, modifiedAt: stat.mtime.toISOString(), examples: countLines(fullPath), source: 'documents' });
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }

  results.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
  return results;
}

// ─── Prepare Docs ────────────────────────────────────────────────────

/**
 * Run the document processor to convert user-selected documents into
 * training QA pairs. Saves the config, spawns documents_processor.py,
 * and streams progress updates via 'training-prepare-progress' IPC.
 */
export async function prepareDocs(
  folders: string[],
  files: string[],
  options?: { prompt: string; modelId: string; modelProvider: string; outputFilename: string },
): Promise<{ filesProcessed: number; pairsGenerated: number }> {
  window.send('training-prepare-progress' as any, { phase: 'saving', message: 'Saving selections…' });

  const configPath = getDocsConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ folders, files, file_types: SUPPORTED_FILE_TYPES }, null, 2), 'utf-8');

  const { getLlamaCppService, getTrainingScriptsDir } = await import('@pkg/agent/services/LlamaCppService');
  const service = getLlamaCppService();
  const python = service.getTrainingPython();

  if (!python) {
    window.send('training-prepare-progress' as any, { phase: 'error', message: 'Training environment not installed. Install it first from the Training panel.' });
    throw new Error('Training environment not installed');
  }

  const { app } = require('electron');
  const llmRoot = path.join(app.getPath('userData'), 'llm');
  const scriptsDir = getTrainingScriptsDir();
  const docScript = path.join(scriptsDir, 'documents_processor.py');

  const scriptArgs = [docScript, '--llm-root', llmRoot];
  if (options?.prompt) scriptArgs.push('--prompt', options.prompt);
  if (options?.modelId) scriptArgs.push('--model', options.modelId);
  if (options?.modelProvider) scriptArgs.push('--provider', options.modelProvider);
  if (options?.outputFilename) scriptArgs.push('--output', options.outputFilename);

  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  if (options?.modelProvider && options.modelProvider !== 'local') {
    try {
      const Settings = await getSettingsModel();
      const apiKey = await Settings.get(`${options.modelProvider.toLowerCase()}ApiKey`, '');
      if (apiKey) env.LLM_API_KEY = apiKey;
    } catch { /* ok */ }
  }

  window.send('training-prepare-progress' as any, { phase: 'processing', message: 'Processing documents…', processed: 0, total: 0 });

  return new Promise((resolve, reject) => {
    const proc = require('child_process').spawn(python, scriptArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    let processed = 0;
    let totalPairs = 0;
    let stdoutBuf = '';

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        const okMatch = trimmed.match(/\[OK\]\s+Processed.*?:\s+(.+?)\s+\((\d+)\s+pairs?\)/);
        if (okMatch) {
          processed++;
          const pairs = parseInt(okMatch[2], 10);
          totalPairs += pairs;
          window.send('training-prepare-progress' as any, { phase: 'file-ok', file: okMatch[1], pairs, processed, total: totalPairs, message: `Processed ${okMatch[1]}` });
        }
        const skipMatch = trimmed.match(/\[SKIP\]\s+(.*)/);
        if (skipMatch) {
          window.send('training-prepare-progress' as any, { phase: 'file-skip', file: skipMatch[1], message: `Skipped: ${skipMatch[1]}`, processed, total: totalPairs });
        }
        const summaryMatch = trimmed.match(/\[documents_processor\]\s+Processed\s+(\d+)\s+files?,\s+(\d+)\s+new\s+pairs?/);
        if (summaryMatch) {
          processed = parseInt(summaryMatch[1], 10);
          totalPairs = parseInt(summaryMatch[2], 10);
        }
        if (trimmed.includes('No new or changed documents')) {
          window.send('training-prepare-progress' as any, { phase: 'processing', message: 'All documents already up to date', processed: 0, total: 0 });
        }
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      console.error('[documents_processor stderr]', chunk.toString());
    });

    proc.on('close', (code: number | null) => {
      if (code === 0) {
        window.send('training-prepare-progress' as any, { phase: 'done', message: processed > 0 ? `Done — ${processed} file(s), ${totalPairs} training pair(s) generated` : 'Done — all documents already up to date', processed, total: totalPairs });
        resolve({ filesProcessed: processed, pairsGenerated: totalPairs });
      } else {
        const msg = `Document processing exited with code ${code}`;
        window.send('training-prepare-progress' as any, { phase: 'error', message: msg });
        reject(new Error(msg));
      }
    });

    proc.on('error', (err: Error) => {
      window.send('training-prepare-progress' as any, { phase: 'error', message: err.message });
      reject(err);
    });
  });
}
