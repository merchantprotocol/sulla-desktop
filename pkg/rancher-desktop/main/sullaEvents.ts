/**
 * Sulla-specific IPC event handlers for the Agent UI.
 */

import * as fs from 'fs';
import * as path from 'path';

import { getIpcMainProxy } from '@pkg/main/ipcMain';
import * as window from '@pkg/window';
import Logging from '@pkg/utils/logging';

const console = Logging.background;
const ipcMainProxy = getIpcMainProxy(console);

/** Directory where training run logs are stored */
function getTrainingLogsDir(): string {
  try {
    const { app } = require('electron');
    return path.join(app.getPath('userData'), 'llm', 'training', 'logs');
  } catch {
    return path.join(process.cwd(), 'llm', 'training', 'logs');
  }
}

/** Active training child process (only one at a time) */
let activeTrainingProcess: ReturnType<typeof import('child_process').spawn> | null = null;
let isTrainingRunning = false;

/**
 * Initialize Sulla-specific IPC handlers.
 */
export function initSullaEvents(): void {

  /**
   * Run training manually. Spawns the training pipeline as a child process,
   * captures stdout/stderr to a timestamped log file, and returns the log filename.
   */
  ipcMainProxy.handle('training-run', async(_event: unknown, modelKey: string, sources: { documentProcessing: boolean; loraTraining: boolean; skills: boolean }) => {
    if (isTrainingRunning) {
      throw new Error('A training run is already in progress');
    }

    const { getLlamaCppService, GGUF_MODELS, getTrainingScriptsDir } = await import('@pkg/agent/services/LlamaCppService');
    const service = getLlamaCppService();

    const entry = GGUF_MODELS[modelKey];
    if (!entry?.trainingRepo) {
      throw new Error(`Model ${modelKey} has no training repo configured`);
    }

    // Create log file immediately so the UI can start tailing
    const { app } = require('electron');
    const llmRoot = path.join(app.getPath('userData'), 'llm');
    const logsDir = getTrainingLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logFilename = `training-${timestamp}.log`;
    const logPath = path.join(logsDir, logFilename);

    // Build enabled-sources summary
    const enabledSources: string[] = [];
    if (sources.documentProcessing) enabledSources.push('Document Processing');
    if (sources.loraTraining) enabledSources.push('LoRA Training');
    if (sources.skills) enabledSources.push('Skills');

    // Write initial log header
    const header = [
      `=== Sulla Training Run ===`,
      `Started: ${new Date().toISOString()}`,
      `Model: ${modelKey} (${entry.trainingRepo})`,
      `Sources: ${enabledSources.join(', ') || 'none'}`,
      `LLM Root: ${llmRoot}`,
      ``,
      `--- Preparing Training Environment ---`,
      ``,
    ].join('\n');
    fs.writeFileSync(logPath, header, 'utf-8');

    // Mark training as active for status polling
    isTrainingRunning = true;

    // Fire-and-forget — the UI will poll the log file
    const runAll = async() => {
      try {
        // Training environment must already be installed via the
        // "Install Training Environment" button in the Model Training window.
        const python = service.getTrainingPython();
        if (!python) {
          fs.appendFileSync(logPath, `\n[ERROR] Training environment not installed. Open the Model Training window and click "Install Training Environment" first.\n`, 'utf-8');
          return;
        }

        fs.appendFileSync(logPath, `\nPython: ${python}\n`, 'utf-8');

        const scriptsDir = getTrainingScriptsDir();
        const trainScript = path.join(scriptsDir, 'train_nightly.py');
        const docScript = path.join(scriptsDir, 'documents_processor.py');

        // Run a child-process phase, piping output to log
        const runPhase = (label: string, script: string, args: string[]): Promise<void> => {
          return new Promise((resolve, reject) => {
            fs.appendFileSync(logPath, `\n--- ${label} ---\n\n`, 'utf-8');
            const proc = require('child_process').spawn(python, [script, ...args], {
              stdio: ['ignore', 'pipe', 'pipe'],
              env:   { ...process.env },
            });
            activeTrainingProcess = proc;

            proc.stdout?.on('data', (chunk: Buffer) => {
              fs.appendFileSync(logPath, chunk);
            });
            proc.stderr?.on('data', (chunk: Buffer) => {
              fs.appendFileSync(logPath, chunk);
            });
            proc.on('close', (code: number | null) => {
              activeTrainingProcess = null;
              if (code === 0) {
                fs.appendFileSync(logPath, `\n[${label}] Completed successfully (exit code 0)\n`, 'utf-8');
                resolve();
              } else {
                fs.appendFileSync(logPath, `\n[${label}] Failed with exit code ${code}\n`, 'utf-8');
                reject(new Error(`${label} failed with exit code ${code}`));
              }
            });
            proc.on('error', (err: Error) => {
              activeTrainingProcess = null;
              fs.appendFileSync(logPath, `\n[${label}] Process error: ${err.message}\n`, 'utf-8');
              reject(err);
            });
          });
        };

        // Phase 1: Document Processing (only if selected)
        if (sources.documentProcessing) {
          try {
            await runPhase('Documents Processing', docScript, ['--llm-root', llmRoot]);
          } catch {
            fs.appendFileSync(logPath, `\nDocument processing failed, continuing...\n`, 'utf-8');
          }
        } else {
          fs.appendFileSync(logPath, `\n[Skipped] Document Processing (not selected)\n`, 'utf-8');
        }

        // Phase 2: LoRA Training (only if selected)
        if (sources.loraTraining) {
          try {
            await runPhase('LoRA Training', trainScript, ['--model', entry.trainingRepo!, '--llm-root', llmRoot]);
          } catch {
            // Error already logged to file
          }
        } else {
          fs.appendFileSync(logPath, `\n[Skipped] LoRA Training (not selected)\n`, 'utf-8');
        }

        // Phase 3: Skills (placeholder — not yet implemented)
        if (sources.skills) {
          fs.appendFileSync(logPath, `\n--- Skills Training ---\n\n`, 'utf-8');
          fs.appendFileSync(logPath, `[Skills] Skills-based training is not yet implemented. This phase was skipped.\n`, 'utf-8');
        } else {
          fs.appendFileSync(logPath, `\n[Skipped] Skills Training (not selected)\n`, 'utf-8');
        }
      } catch (err) {
        fs.appendFileSync(logPath, `\n[ERROR] ${err}\n`, 'utf-8');
      } finally {
        isTrainingRunning = false;
        fs.appendFileSync(logPath, `\n=== Training Run Finished: ${new Date().toISOString()} ===\n`, 'utf-8');
      }
    };

    runAll().catch(() => { isTrainingRunning = false; });

    return { logFilename, logPath };
  });

  /**
   * Check if a training run is currently in progress.
   */
  ipcMainProxy.handle('training-status', async() => {
    return { running: isTrainingRunning };
  });

  /**
   * Get the list of training run logs (newest first).
   */
  ipcMainProxy.handle('training-history', async() => {
    const logsDir = getTrainingLogsDir();
    if (!fs.existsSync(logsDir)) {
      return [];
    }

    const files = fs.readdirSync(logsDir)
      .filter(f => f.startsWith('training-') && f.endsWith('.log'))
      .sort()
      .reverse();

    return files.map(filename => {
      const filePath = path.join(logsDir, filename);
      const stat = fs.statSync(filePath);
      // Parse timestamp from filename: training-2026-03-04T06-00-00-000Z.log
      const tsMatch = filename.match(/^training-(.+)\.log$/);
      const timestamp = tsMatch ? tsMatch[1].replace(/-/g, (m, offset) => {
        // Restore ISO format: first 3 dashes are date separators, then T, then colons and dots
        if (offset < 10) return offset === 4 || offset === 7 ? '-' : m;
        return m;
      }) : '';

      return {
        filename,
        size:      stat.size,
        createdAt: stat.birthtime.toISOString(),
        modifiedAt: stat.mtime.toISOString(),
      };
    });
  });

  /**
   * Read the contents of a training log file.
   */
  ipcMainProxy.handle('training-log-read', async(_event: unknown, filename: string) => {
    // Prevent path traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      throw new Error('Invalid filename');
    }
    const logsDir = getTrainingLogsDir();
    const filePath = path.join(logsDir, filename);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Log file not found: ${filename}`);
    }
    return fs.readFileSync(filePath, 'utf-8');
  });

  /**
   * Save/load the training schedule setting.
   */
  ipcMainProxy.handle('training-schedule-get', async() => {
    const { SullaSettingsModel } = await import('@pkg/agent/database/models/SullaSettingsModel');
    const enabled = await SullaSettingsModel.get('trainingScheduleEnabled', false);
    const hour = await SullaSettingsModel.get('trainingScheduleHour', 2);
    const minute = await SullaSettingsModel.get('trainingScheduleMinute', 0);
    return { enabled, hour, minute };
  });

  /**
   * Return downloaded GGUF models that have an associated training repo.
   * Only these can be fine-tuned. The key is the GGUF model key (used by
   * training-run), trainingRepo is the Unsloth HF repo for display.
   */
  ipcMainProxy.handle('training-models-downloaded', async() => {
    const { GGUF_MODELS, getLlamaCppService } = await import('@pkg/agent/services/LlamaCppService');
    const svc = getLlamaCppService();
    const results: Array<{ key: string; displayName: string; trainingRepo: string }> = [];

    for (const [key, entry] of Object.entries(GGUF_MODELS)) {
      if (entry.trainingRepo && svc.getModelPath(key)) {
        results.push({
          key,
          displayName: entry.displayName,
          trainingRepo: entry.trainingRepo,
        });
      }
    }

    return results;
  });

  ipcMainProxy.handle('training-schedule-set', async(_event: unknown, opts: { enabled: boolean; hour: number; minute: number }) => {
    const { SullaSettingsModel } = await import('@pkg/agent/database/models/SullaSettingsModel');
    await SullaSettingsModel.set('trainingScheduleEnabled', opts.enabled, 'boolean');
    await SullaSettingsModel.set('trainingScheduleHour', opts.hour, 'number');
    await SullaSettingsModel.set('trainingScheduleMinute', opts.minute, 'number');

    // Reschedule the timer
    rescheduleNightlyTraining(opts.enabled, opts.hour, opts.minute);

    return { ok: true };
  });

  // On startup, load the schedule and arm the timer
  (async() => {
    try {
      const { SullaSettingsModel } = await import('@pkg/agent/database/models/SullaSettingsModel');
      const enabled = await SullaSettingsModel.get('trainingScheduleEnabled', false);
      const hour = await SullaSettingsModel.get('trainingScheduleHour', 2);
      const minute = await SullaSettingsModel.get('trainingScheduleMinute', 0);
      if (enabled) {
        rescheduleNightlyTraining(true, hour, minute);
      }
    } catch {
      // Settings DB may not be ready yet — that's okay
    }
  })();

  /**
   * Check which LOCAL_MODELS keys have their GGUF file downloaded on disk.
   * Returns a Record<modelKey, boolean>.
   */
  ipcMainProxy.handle('local-models-status', async() => {
    const { GGUF_MODELS, getLlamaCppService } = await import('@pkg/agent/services/LlamaCppService');
    const svc = getLlamaCppService();
    const { LOCAL_MODELS } = await import('@pkg/shared/localModels');
    const status: Record<string, boolean> = {};

    for (const model of LOCAL_MODELS) {
      status[model.name] = svc.getModelPath(model.name) !== null;
    }

    return status;
  });

  /**
   * Download a GGUF model by key. Returns { ok: true } on success.
   * The download is blocking — the renderer should show a spinner.
   */
  ipcMainProxy.handle('local-model-download', async(_event: unknown, modelKey: string) => {
    const { getLlamaCppService } = await import('@pkg/agent/services/LlamaCppService');
    const svc = getLlamaCppService();
    await svc.downloadModel(modelKey);
    return { ok: true };
  });

  // ── Document Processing Config ──────────────────────────────────────

  /** Path to documents_config.json inside the training directory */
  function getDocsConfigPath(): string {
    try {
      const { app } = require('electron');
      return path.join(app.getPath('userData'), 'llm', 'training', 'documents_config.json');
    } catch {
      return path.join(process.cwd(), 'llm', 'training', 'documents_config.json');
    }
  }

  const SUPPORTED_FILE_TYPES = ['.txt', '.md', '.pdf', '.docx'];

  /** Check whether documents_config.json exists (used to gate the checkbox). */
  ipcMainProxy.handle('training-docs-config-exists', async() => {
    return fs.existsSync(getDocsConfigPath());
  });

  /** Load the existing documents_config.json (or return defaults). */
  ipcMainProxy.handle('training-docs-config-load', async() => {
    const configPath = getDocsConfigPath();
    if (fs.existsSync(configPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        return {
          folders:   Array.isArray(raw.folders) ? raw.folders as string[] : [],
          files:     Array.isArray(raw.files) ? raw.files as string[] : [],
          fileTypes: Array.isArray(raw.file_types) ? raw.file_types as string[] : SUPPORTED_FILE_TYPES,
        };
      } catch {
        // Corrupted file — return defaults
      }
    }
    return { folders: [], files: [], fileTypes: SUPPORTED_FILE_TYPES };
  });

  /** List immediate children (dirs + compatible files) of any directory. */
  ipcMainProxy.handle('training-docs-list-dir', async(_event: unknown, dirPath: string) => {
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
      console.error('[Sulla] Failed to list directory:', dirPath, err);
    }

    // Dirs first, then files, both alphabetical
    results.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return results;
  });

  /** Save the documents_config.json with the user's chosen folders, files, and file types. */
  ipcMainProxy.handle('training-docs-config-save', async(_event: unknown, folders: string[], files: string[], fileTypes: string[]) => {
    const configPath = getDocsConfigPath();
    // Ensure the training directory exists
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const config = {
      folders,
      files,
      file_types: fileTypes && fileTypes.length > 0 ? fileTypes : SUPPORTED_FILE_TYPES,
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    console.log(`[Sulla] Saved documents_config.json with ${folders.length} folders, ${files.length} files`);
    return { ok: true };
  });

  // ── Training Environment Installation ────────────────────────────

  /** Track whether the training environment is currently being installed */
  let isTrainingInstalling = false;
  let trainingInstallError = '';

  /**
   * Check if the training environment is fully installed:
   * - Python venv exists with required packages
   * - Training model is downloaded
   * Returns { installed, installing, error, modelKey }
   */
  ipcMainProxy.handle('training-install-status', async() => {
    const { getLlamaCppService, GGUF_MODELS } = await import('@pkg/agent/services/LlamaCppService');
    const { SullaSettingsModel } = await import('@pkg/agent/database/models/SullaSettingsModel');
    const service = getLlamaCppService();
    const modelKey = await SullaSettingsModel.get('sullaModel', 'qwen3.5-9b');

    const entry = GGUF_MODELS[modelKey];
    const hasPython = service.getTrainingPython() !== null;
    const hasModel = entry?.trainingRepo ? service.getTrainingModelPath(modelKey) !== null : false;
    const installed = hasPython && hasModel;

    return {
      installed,
      installing:  isTrainingInstalling,
      error:       trainingInstallError,
      modelKey,
      displayName: entry?.displayName ?? modelKey,
      trainingRepo: entry?.trainingRepo ?? '',
    };
  });

  /**
   * Run the full training environment installation:
   * 1. Create Python venv + install all deps (pip)
   * 2. Download the training model from HuggingFace
   *
   * Sends 'training-install-progress' events to all windows with:
   *   { phase, description, current, max, fileName?, bytesReceived?, bytesTotal? }
   */
  ipcMainProxy.handle('training-install', async() => {
    if (isTrainingInstalling) {
      throw new Error('Training environment installation is already in progress');
    }

    const { getLlamaCppService, GGUF_MODELS } = await import('@pkg/agent/services/LlamaCppService');
    const { SullaSettingsModel } = await import('@pkg/agent/database/models/SullaSettingsModel');
    const service = getLlamaCppService();
    const modelKey = await SullaSettingsModel.get('sullaModel', 'qwen3.5-9b');

    const entry = GGUF_MODELS[modelKey];
    if (!entry?.trainingRepo) {
      throw new Error(`Model ${modelKey} has no training repo configured`);
    }

    isTrainingInstalling = true;
    trainingInstallError = '';

    const sendProgress = (data: {
      phase: string;
      description: string;
      current: number;
      max: number;
      fileName?: string;
      bytesReceived?: number;
      bytesTotal?: number;
    }) => {
      window.send('training-install-progress' as any, data);
    };

    // Create log file
    const logsDir = getTrainingLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logFilename = `install-${timestamp}.log`;
    const logPath = path.join(logsDir, logFilename);
    fs.writeFileSync(logPath, `=== Training Environment Install ===\nStarted: ${new Date().toISOString()}\nModel: ${modelKey} (${entry.trainingRepo})\n\n`, 'utf-8');

    // Fire-and-forget: run the install in the background.
    // Progress is streamed via 'training-install-progress' events.
    // Return the log filename immediately so the UI can start tailing.
    const runInstall = async() => {
      try {
        // Phase 1: Install Python deps
        sendProgress({ phase: 'deps', description: 'Installing Python dependencies...', current: 0, max: 100 });

        await service.installTrainingDeps(logPath, (description, current, max) => {
          sendProgress({ phase: 'deps', description, current, max });
        });

        // Phase 2: Write default documents config
        service['writeDocumentsConfig']();

        // Phase 3: Download training model
        sendProgress({ phase: 'model', description: `Downloading training model ${entry.trainingRepo}...`, current: 0, max: 100 });

        await service.downloadTrainingModel(modelKey, logPath, (fileIndex, fileCount, fileName, bytesReceived, bytesTotal) => {
          const overallPct = Math.round(((fileIndex + bytesReceived / bytesTotal) / fileCount) * 100);
          sendProgress({
            phase:         'model',
            description:   `Downloading ${fileName} (${fileIndex + 1}/${fileCount})`,
            current:       overallPct,
            max:           100,
            fileName,
            bytesReceived,
            bytesTotal,
          });
        });

        sendProgress({ phase: 'done', description: 'Training environment installed successfully', current: 100, max: 100 });
        fs.appendFileSync(logPath, `\n=== Install Complete: ${new Date().toISOString()} ===\n`, 'utf-8');
      } catch (err: any) {
        trainingInstallError = err?.message || String(err);
        fs.appendFileSync(logPath, `\n[ERROR] ${trainingInstallError}\n`, 'utf-8');
        sendProgress({ phase: 'error', description: trainingInstallError, current: 0, max: 100 });
      } finally {
        isTrainingInstalling = false;
      }
    };

    runInstall().catch(() => { isTrainingInstalling = false; });

    return { logFilename };
  });

  console.log('[Sulla] IPC event handlers initialized');
}

/** Timer handle for the nightly training schedule */
let nightlyTrainingTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Schedule (or cancel) the next nightly training run.
 */
function rescheduleNightlyTraining(enabled: boolean, hour: number, minute: number): void {
  if (nightlyTrainingTimer) {
    clearTimeout(nightlyTrainingTimer);
    nightlyTrainingTimer = null;
  }

  if (!enabled) {
    console.log('[Sulla] Nightly training schedule disabled');
    return;
  }

  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }

  const delayMs = next.getTime() - now.getTime();
  console.log(`[Sulla] Next nightly training scheduled for ${next.toISOString()} (in ${Math.round(delayMs / 60000)} min)`);

  nightlyTrainingTimer = setTimeout(async() => {
    console.log('[Sulla] Nightly training timer fired');
    try {
      const { getLlamaCppService } = await import('@pkg/agent/services/LlamaCppService');
      const { SullaSettingsModel } = await import('@pkg/agent/database/models/SullaSettingsModel');
      const modelKey = await SullaSettingsModel.get('sullaModel', 'qwen3.5-9b');
      const service = getLlamaCppService();

      // Create log file for nightly run
      const fs = require('fs');
      const logsDir = getTrainingLogsDir();
      fs.mkdirSync(logsDir, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFilename = `training-${timestamp}.log`;
      const logPath = path.join(logsDir, logFilename);
      fs.writeFileSync(logPath, `=== Nightly Training Run (Scheduled) ===\nStarted: ${new Date().toISOString()}\nModel: ${modelKey}\n\n`, 'utf-8');

      await service.runFullNightlyTraining(modelKey);
      fs.appendFileSync(logPath, `\n=== Completed: ${new Date().toISOString()} ===\n`, 'utf-8');
    } catch (err) {
      console.error('[Sulla] Nightly training failed:', err);
    }

    // Re-arm for the next day
    rescheduleNightlyTraining(true, hour, minute);
  }, delayMs);

  // Don't keep the app alive just for this timer
  nightlyTrainingTimer.unref();
}
