/**
 * Sulla-specific IPC event handlers for the Agent UI.
 */

import * as fs from 'fs';
import * as path from 'path';

import { getIpcMainProxy } from '@pkg/main/ipcMain';
import * as window from '@pkg/window';
import Logging from '@pkg/utils/logging';
import { initSullaWorkflowEvents } from './sullaWorkflowEvents';

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

/** Lock file path for cross-restart training protection */
function getTrainingLockFile(): string {
  try {
    const { app } = require('electron');
    return path.join(app.getPath('userData'), 'llm', 'training', '.training.lock');
  } catch {
    return path.join(process.cwd(), 'llm', 'training', '.training.lock');
  }
}

/** Write a lock file with PID so stale locks can be detected */
function acquireTrainingLock(): void {
  const lockFile = getTrainingLockFile();
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), 'utf-8');
  isTrainingRunning = true;
}

/** Remove the lock file */
function releaseTrainingLock(): void {
  isTrainingRunning = false;
  try { fs.unlinkSync(getTrainingLockFile()); } catch { /* already gone */ }
}

/** Check if training is actually running (handles stale locks from crashed processes) */
function isTrainingLocked(): boolean {
  if (isTrainingRunning) return true;
  const lockFile = getTrainingLockFile();
  if (!fs.existsSync(lockFile)) return false;
  try {
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf-8'));
    // Check if the PID that wrote the lock is still alive
    process.kill(lock.pid, 0); // signal 0 = existence check, no actual signal sent
    return true; // process is still alive
  } catch {
    // PID is dead or lock file is corrupt — stale lock, clean it up
    try { fs.unlinkSync(lockFile); } catch { /* ignore */ }
    return false;
  }
}

/** Resolve the absolute sulla home directory */
function getSullaHomeDir(): string {
  const os = require('os');
  const envPath = String(process.env.SULLA_HOME_DIR || '').trim();
  if (envPath && path.isAbsolute(envPath)) return envPath;
  if (envPath) return path.resolve(envPath);
  return path.join(os.homedir(), 'sulla');
}

/** Ensure a path is within the sulla home directory (sandbox) */
function assertInsideSullaHome(targetPath: string): string {
  const root = getSullaHomeDir();
  const resolved = path.resolve(targetPath);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error(`Path is outside sulla home: ${resolved}`);
  }
  return resolved;
}

/**
 * Initialize Sulla-specific IPC handlers.
 */
export function initSullaEvents(): void {

  // ─────────────────────────────────────────────────────────────
  // Filesystem handlers
  // ─────────────────────────────────────────────────────────────

  ipcMainProxy.handle('filesystem-get-root', async() => {
    const root = getSullaHomeDir();
    fs.mkdirSync(root, { recursive: true });
    return root;
  });

  ipcMainProxy.handle('filesystem-get-git-changes', async (event, path) => {
    const { execSync } = require('child_process');
    try {
      const output = execSync('git status --porcelain', { cwd: path, encoding: 'utf8' });
      const lines = output.split('\n').filter((line: string) => line.trim());
      const changes = lines.map((line: string) => {
        const status = line.slice(0, 2).trim();
        const file = line.slice(3);
        return { status, file };
      });
      return changes;
    } catch (error) {
      console.error('Error getting git changes:', error);
      return [];
    }
  });

  // ─── Git source control handlers ─────────────────────────────────

  /**
   * Discover git repositories at `dirPath` and up to 3 levels of subdirectories.
   * Returns an array of { root, name } for each unique repo found.
   */
  ipcMainProxy.handle('git-discover-repos', async (_event: unknown, dirPath: string) => {
    const { execSync } = require('child_process');
    const repoRoots = new Set<string>();
    const results: Array<{ root: string; name: string }> = [];

    function probe(dir: string): string | null {
      try {
        return execSync('git rev-parse --show-toplevel', { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim();
      } catch {
        return null;
      }
    }

    function scan(dir: string, depth: number) {
      // Check if this directory is inside a git repo
      const root = probe(dir);
      if (root && !repoRoots.has(root)) {
        repoRoots.add(root);
        results.push({ root, name: path.basename(root) });
      }

      // If we already found a repo at this dir, don't scan its children
      // (they'd be the same repo). Only recurse if no repo found here.
      if (root || depth >= 3) return;

      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
          scan(path.join(dir, entry.name), depth + 1);
        }
      } catch { /* permission errors, etc. */ }
    }

    scan(dirPath, 0);
    return results;
  });

  ipcMainProxy.handle('git-branch', async (_event: unknown, dirPath: string) => {
    const { execSync } = require('child_process');
    try {
      return execSync('git rev-parse --abbrev-ref HEAD', { cwd: dirPath, encoding: 'utf8', stdio: 'pipe' }).trim();
    } catch {
      return '';
    }
  });

  ipcMainProxy.handle('git-list-branches', async (_event: unknown, dirPath: string) => {
    const { execSync } = require('child_process');
    try {
      const output = execSync('git branch -a --no-color', { cwd: dirPath, encoding: 'utf8', stdio: 'pipe' });
      const branches: Array<{ name: string; current: boolean; remote: boolean }> = [];
      const seen = new Set<string>();
      for (const line of output.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.includes('->')) continue;
        const current = line.startsWith('*');
        const remote = trimmed.startsWith('remotes/');
        const name = trimmed.replace(/^\*\s*/, '').replace(/^remotes\/origin\//, '');
        if (seen.has(name)) continue;
        seen.add(name);
        branches.push({ name, current, remote });
      }
      return branches;
    } catch {
      return [];
    }
  });

  ipcMainProxy.handle('git-checkout-branch', async (_event: unknown, dirPath: string, branchName: string) => {
    const { execSync } = require('child_process');
    try {
      execSync(`git checkout "${branchName}"`, { cwd: dirPath, encoding: 'utf8', stdio: 'pipe' });
      return { success: true, error: '' };
    } catch (err: any) {
      return { success: false, error: err.stderr || err.message };
    }
  });

  ipcMainProxy.handle('git-create-branch', async (_event: unknown, dirPath: string, branchName: string) => {
    const { execSync } = require('child_process');
    try {
      execSync(`git checkout -b "${branchName}"`, { cwd: dirPath, encoding: 'utf8', stdio: 'pipe' });
      return { success: true, error: '' };
    } catch (err: any) {
      return { success: false, error: err.stderr || err.message };
    }
  });

  ipcMainProxy.handle('git-status-full', async (_event: unknown, dirPath: string) => {
    const { execSync } = require('child_process');
    try {
      const output = execSync('git status --porcelain', { cwd: dirPath, encoding: 'utf8', stdio: 'pipe' });
      const lines = output.split('\n').filter((line: string) => line.trim());
      return lines.map((line: string) => {
        const index = line[0];
        const worktree = line[1];
        const file = line.slice(3);
        return { index, worktree, file };
      });
    } catch {
      return [];
    }
  });

  ipcMainProxy.handle('git-stage', async (_event: unknown, dirPath: string, files: string[]) => {
    const { execSync } = require('child_process');
    try {
      const fileArgs = files.map((f: string) => `"${f}"`).join(' ');
      execSync(`git add ${fileArgs}`, { cwd: dirPath, encoding: 'utf8', stdio: 'pipe' });
      return true;
    } catch (err: any) {
      console.error('[git-stage] Error:', err.message);
      return false;
    }
  });

  ipcMainProxy.handle('git-unstage', async (_event: unknown, dirPath: string, files: string[]) => {
    const { execSync } = require('child_process');
    try {
      const fileArgs = files.map((f: string) => `"${f}"`).join(' ');
      execSync(`git reset HEAD ${fileArgs}`, { cwd: dirPath, encoding: 'utf8', stdio: 'pipe' });
      return true;
    } catch (err: any) {
      console.error('[git-unstage] Error:', err.message);
      return false;
    }
  });

  ipcMainProxy.handle('git-diff', async (_event: unknown, dirPath: string, file: string, staged: boolean) => {
    const { execSync } = require('child_process');
    try {
      const cmd = staged ? `git diff --cached "${file}"` : `git diff "${file}"`;
      return execSync(cmd, { cwd: dirPath, encoding: 'utf8', stdio: 'pipe' });
    } catch {
      return '';
    }
  });

  // Get the HEAD (committed) version of a file for diff comparison
  ipcMainProxy.handle('git-show-head', async (_event: unknown, dirPath: string, file: string) => {
    const { execSync } = require('child_process');
    try {
      return execSync(`git show HEAD:"${file}"`, { cwd: dirPath, encoding: 'utf8', stdio: 'pipe' });
    } catch {
      return '';
    }
  });

  // Get the staged version of a file for diff comparison
  ipcMainProxy.handle('git-show-staged', async (_event: unknown, dirPath: string, file: string) => {
    const { execSync } = require('child_process');
    try {
      return execSync(`git show :"${file}"`, { cwd: dirPath, encoding: 'utf8', stdio: 'pipe' });
    } catch {
      return '';
    }
  });

  ipcMainProxy.handle('git-commit', async (_event: unknown, dirPath: string, message: string) => {
    const { execSync } = require('child_process');
    try {
      const escaped = message.replace(/"/g, '\\"');
      execSync(`git commit -m "${escaped}"`, { cwd: dirPath, encoding: 'utf8', stdio: 'pipe' });
      return true;
    } catch (err: any) {
      console.error('[git-commit] Error:', err.message);
      return false;
    }
  });

  ipcMainProxy.handle('git-pull', async (_event: unknown, dirPath: string) => {
    const { execSync } = require('child_process');
    try {
      const output = execSync('git pull', { cwd: dirPath, encoding: 'utf8', stdio: 'pipe', timeout: 60_000 });
      return { success: true, output: output.trim() };
    } catch (err: any) {
      return { success: false, output: err.stderr || err.message };
    }
  });

  ipcMainProxy.handle('git-push', async (_event: unknown, dirPath: string) => {
    const { execSync } = require('child_process');
    try {
      const output = execSync('git push', { cwd: dirPath, encoding: 'utf8', stdio: 'pipe', timeout: 60_000 });
      return { success: true, output: (output || '').trim() };
    } catch (err: any) {
      // git push writes to stderr even on success
      const stderr = err.stderr || '';
      if (err.status === 0 || stderr.includes('->')) {
        return { success: true, output: stderr.trim() };
      }
      return { success: false, output: stderr || err.message };
    }
  });

  ipcMainProxy.handle('git-fetch', async (_event: unknown, dirPath: string) => {
    const { execSync } = require('child_process');
    try {
      execSync('git fetch --all', { cwd: dirPath, encoding: 'utf8', stdio: 'pipe', timeout: 60_000 });
      return { success: true, output: 'Fetched all remotes.' };
    } catch (err: any) {
      return { success: false, output: err.stderr || err.message };
    }
  });

  ipcMainProxy.handle('git-stash', async (_event: unknown, dirPath: string) => {
    const { execSync } = require('child_process');
    try {
      const output = execSync('git stash', { cwd: dirPath, encoding: 'utf8', stdio: 'pipe' });
      return { success: true, output: output.trim() };
    } catch (err: any) {
      return { success: false, output: err.stderr || err.message };
    }
  });

  ipcMainProxy.handle('git-stash-pop', async (_event: unknown, dirPath: string) => {
    const { execSync } = require('child_process');
    try {
      const output = execSync('git stash pop', { cwd: dirPath, encoding: 'utf8', stdio: 'pipe' });
      return { success: true, output: output.trim() };
    } catch (err: any) {
      return { success: false, output: err.stderr || err.message };
    }
  });

  ipcMainProxy.handle('git-discard-all', async (_event: unknown, dirPath: string) => {
    const { execSync } = require('child_process');
    try {
      execSync('git checkout -- .', { cwd: dirPath, encoding: 'utf8', stdio: 'pipe' });
      execSync('git clean -fd', { cwd: dirPath, encoding: 'utf8', stdio: 'pipe' });
      return { success: true, output: 'Discarded all changes.' };
    } catch (err: any) {
      return { success: false, output: err.stderr || err.message };
    }
  });

  ipcMainProxy.handle('git-add-gitignore', async (_event: unknown, repoRoot: string, pattern: string) => {
    try {
      const gitignorePath = path.join(repoRoot, '.gitignore');
      let content = '';
      try { content = fs.readFileSync(gitignorePath, 'utf8'); } catch { /* file may not exist */ }
      // Check if pattern already exists
      const lines = content.split('\n');
      if (lines.some(l => l.trim() === pattern.trim())) {
        return { success: true, output: 'Pattern already in .gitignore' };
      }
      // Append pattern
      const newContent = content.endsWith('\n') || content === '' ? content + pattern + '\n' : content + '\n' + pattern + '\n';
      fs.writeFileSync(gitignorePath, newContent, 'utf8');
      return { success: true, output: `Added "${pattern}" to .gitignore` };
    } catch (err: any) {
      return { success: false, output: err.message };
    }
  });

  ipcMainProxy.handle('filesystem-read-dir', async(_event: unknown, dirPath: string) => {
    const resolved = assertInsideSullaHome(dirPath);
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    return entries
      .map((e) => {
        const fullPath = path.join(resolved, e.name);
        const isDir = e.isDirectory();
        let size = 0;
        try {
          if (!isDir) size = fs.statSync(fullPath).size;
        } catch { /* ignore */ }
        return {
          name:    e.name,
          path:    fullPath,
          isDir,
          size,
          ext:     isDir ? '' : path.extname(e.name).toLowerCase(),
        };
      })
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  });

  ipcMainProxy.handle('filesystem-read-file', async(_event: unknown, filePath: string) => {
    console.log('filesystem-read-file called with path:', filePath);
    const resolved = assertInsideSullaHome(filePath);
    console.log('Resolved path:', resolved);
    const stat = fs.statSync(resolved);
    if (stat.size > 5 * 1024 * 1024) {
      throw new Error('File too large to open (>5MB)');
    }
    const content = fs.readFileSync(resolved, 'utf-8');
    console.log('File read successfully, size:', content.length);
    return content;
  });

  ipcMainProxy.handle('filesystem-write-file', async(_event: unknown, filePath: string, content: string) => {
    const resolved = assertInsideSullaHome(filePath);
    fs.writeFileSync(resolved, content, 'utf-8');
  });

  ipcMainProxy.handle('filesystem-save-dialog', async(_event: unknown, defaultName: string, defaultPath?: string) => {
    const { dialog } = require('electron');
    const result = await dialog.showSaveDialog({
      title: 'Save File',
      defaultPath: defaultPath ? path.join(defaultPath, defaultName) : defaultName,
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (result.canceled || !result.filePath) return null;
    return result.filePath;
  });

  ipcMainProxy.handle('filesystem-rename', async(_event: unknown, oldPath: string, newName: string) => {
    const resolved = assertInsideSullaHome(oldPath);
    const newPath = path.join(path.dirname(resolved), newName);
    assertInsideSullaHome(newPath);
    fs.renameSync(resolved, newPath);
    return newPath;
  });

  ipcMainProxy.handle('filesystem-delete', async(_event: unknown, targetPath: string) => {
    const resolved = assertInsideSullaHome(targetPath);
    fs.rmSync(resolved, { recursive: true, force: true });
  });

  ipcMainProxy.handle('filesystem-create-file', async(_event: unknown, dirPath: string, fileName: string) => {
    const dir = assertInsideSullaHome(dirPath);
    const filePath = path.join(dir, fileName);
    assertInsideSullaHome(filePath);
    if (fs.existsSync(filePath)) throw new Error(`File already exists: ${fileName}`);
    fs.writeFileSync(filePath, '', 'utf-8');
    return filePath;
  });

  ipcMainProxy.handle('filesystem-create-dir', async(_event: unknown, dirPath: string, dirName: string) => {
    const dir = assertInsideSullaHome(dirPath);
    const newDir = path.join(dir, dirName);
    assertInsideSullaHome(newDir);
    if (fs.existsSync(newDir)) throw new Error(`Directory already exists: ${dirName}`);
    fs.mkdirSync(newDir, { recursive: true });
    return newDir;
  });

  ipcMainProxy.handle('filesystem-copy', async(_event: unknown, srcPath: string, destDir: string) => {
    const resolvedSrc = assertInsideSullaHome(srcPath);
    const resolvedDest = assertInsideSullaHome(destDir);
    const baseName = path.basename(resolvedSrc);
    let target = path.join(resolvedDest, baseName);
    assertInsideSullaHome(target);

    // If target exists, add a suffix
    if (fs.existsSync(target)) {
      const ext = path.extname(baseName);
      const stem = baseName.slice(0, baseName.length - ext.length);
      let i = 1;
      while (fs.existsSync(target)) {
        target = path.join(resolvedDest, `${stem} (${i})${ext}`);
        i++;
      }
    }

    fs.cpSync(resolvedSrc, target, { recursive: true });
    return target;
  });

  ipcMainProxy.handle('filesystem-move', async(_event: unknown, srcPath: string, destDir: string) => {
    const resolvedSrc = assertInsideSullaHome(srcPath);
    const resolvedDest = assertInsideSullaHome(destDir);
    const baseName = path.basename(resolvedSrc);
    const target = path.join(resolvedDest, baseName);
    assertInsideSullaHome(target);
    if (resolvedSrc === target) return target;
    if (fs.existsSync(target)) throw new Error(`"${baseName}" already exists in destination`);
    fs.renameSync(resolvedSrc, target);
    return target;
  });

  ipcMainProxy.handle('filesystem-reveal', async(_event: unknown, targetPath: string) => {
    const resolved = assertInsideSullaHome(targetPath);
    const { shell } = require('electron');
    shell.showItemInFolder(resolved);
  });

  ipcMainProxy.handle('filesystem-open-external', async(_event: unknown, targetPath: string) => {
    const resolved = assertInsideSullaHome(targetPath);
    const { shell } = require('electron');
    await shell.openPath(resolved);
  });

  ipcMainProxy.handle('filesystem-open-in-editor', async(_event: unknown, targetPath: string, line?: number) => {
    const { spawn } = require('child_process');
    const gotoArg = line ? `${ targetPath }:${ line }` : targetPath;

    spawn('code', ['--goto', gotoArg], {
      detached: true,
      stdio:    'ignore',
    }).unref();
  });

  ipcMainProxy.handle('filesystem-upload', async(_event: unknown, destDir: string, fileName: string, base64Data: string) => {
    const dir = assertInsideSullaHome(destDir);
    let target = path.join(dir, fileName);
    assertInsideSullaHome(target);

    // Avoid overwriting existing files
    if (fs.existsSync(target)) {
      const ext = path.extname(fileName);
      const stem = fileName.slice(0, fileName.length - ext.length);
      let i = 1;
      while (fs.existsSync(target)) {
        target = path.join(dir, `${stem} (${i})${ext}`);
        i++;
      }
    }

    const buffer = Buffer.from(base64Data, 'base64');
    fs.writeFileSync(target, buffer);
    return target;
  });

  /**
   * Run training manually. Spawns the training pipeline as a child process,
   * captures stdout/stderr to a timestamped log file, and returns the log filename.
   */
  ipcMainProxy.handle('training-run', async(_event: unknown, modelKey: string, sources: { documentProcessing: boolean; loraTraining: boolean; skills: boolean }) => {
    if (isTrainingLocked()) {
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

    // Mark training as active for status polling (disk lock + in-memory flag)
    acquireTrainingLock();

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
        const runPhase = (label: string, script: string, args: string[], timeoutMs: number = 7_200_000): Promise<void> => {
          return new Promise((resolve, reject) => {
            fs.appendFileSync(logPath, `\n--- ${label} ---\n\n`, 'utf-8');
            const proc = require('child_process').spawn(python, [script, ...args], {
              stdio: ['ignore', 'pipe', 'pipe'],
              env:   { ...process.env },
              detached: process.platform !== 'win32', // create process group for clean kill
            });
            activeTrainingProcess = proc;
            let settled = false;

            // Timeout guard: kill entire process group if phase hangs
            const timer = setTimeout(() => {
              if (settled) return;
              settled = true;
              fs.appendFileSync(logPath, `\n[${label}] TIMEOUT: exceeded ${Math.round(timeoutMs / 60000)} minutes, killing process\n`, 'utf-8');
              try {
                if (process.platform === 'win32') {
                  require('child_process').execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'pipe' });
                } else if (proc.pid) {
                  process.kill(-proc.pid, 'SIGKILL'); // kill process group
                }
              } catch { /* already dead */ }
              activeTrainingProcess = null;
              reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 60000)} minutes`));
            }, timeoutMs);

            proc.stdout?.on('data', (chunk: Buffer) => {
              fs.appendFileSync(logPath, chunk);
            });
            proc.stderr?.on('data', (chunk: Buffer) => {
              fs.appendFileSync(logPath, chunk);
            });
            proc.on('close', (code: number | null) => {
              clearTimeout(timer);
              if (settled) return;
              settled = true;
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
              clearTimeout(timer);
              if (settled) return;
              settled = true;
              activeTrainingProcess = null;
              fs.appendFileSync(logPath, `\n[${label}] Process error: ${err.message}\n`, 'utf-8');
              reject(err);
            });
          });
        };

        // Phase 1: Document Processing (only if selected)
        if (sources.documentProcessing) {
          try {
            await runPhase('Documents Processing', docScript, ['--llm-root', llmRoot], 600_000);
          } catch {
            fs.appendFileSync(logPath, `\nDocument processing failed, continuing...\n`, 'utf-8');
          }
        } else {
          fs.appendFileSync(logPath, `\n[Skipped] Document Processing (not selected)\n`, 'utf-8');
        }

        // Phase 2: LoRA Training (only if selected)
        if (sources.loraTraining) {
          try {
            await runPhase('LoRA Training', trainScript, ['--model', entry.trainingRepo!, '--llm-root', llmRoot], 7_200_000);
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
        releaseTrainingLock();
        fs.appendFileSync(logPath, `\n=== Training Run Finished: ${new Date().toISOString()} ===\n`, 'utf-8');
      }
    };

    runAll().catch(() => { releaseTrainingLock(); });

    return { logFilename, logPath };
  });

  /**
   * Check if a training run is currently in progress.
   */
  ipcMainProxy.handle('training-status', async() => {
    return { running: isTrainingLocked() };
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

  // ─────────────────────────────────────────────────────────────
  // QMD Search handlers
  // ─────────────────────────────────────────────────────────────

  ipcMainProxy.handle('qmd-index', async(_event: unknown, dirPath: string, glob?: string) => {
    const { indexDirectory } = require('@pkg/main/qmdService');

    return await indexDirectory(dirPath, glob);
  });

  ipcMainProxy.handle('qmd-search', async(_event: unknown, query: string, dirPath: string) => {
    const { search } = require('@pkg/main/qmdService');

    return await search(query, dirPath);
  });

  // ─────────────────────────────────────────────────────────────
  // Docker handlers
  // ─────────────────────────────────────────────────────────────

  ipcMainProxy.handle('docker-list-containers', async () => {
    const { execSync } = require('child_process');

    try {
      const raw = execSync('docker ps -a --format "{{json .}}"', {
        encoding: 'utf8',
        timeout:  15000,
      }).trim();

      if (!raw) return [];

      return raw.split('\n').filter((l: string) => l.trim()).map((line: string) => {
        const c = JSON.parse(line);
        const labels = c.Labels || '';
        const projectMatch = labels.match(/com\.docker\.compose\.project=([^,]+)/);

        return {
          id:             c.ID,
          name:           c.Names,
          image:          c.Image,
          status:         c.Status,
          state:          c.State,
          ports:          c.Ports,
          composeProject: projectMatch ? projectMatch[1] : '',
        };
      });
    } catch (err: any) {
      console.error('[Sulla] docker-list-containers failed:', err.message);

      return [];
    }
  });

  // ─────────────────────────────────────────────────────────────
  // Agent handlers
  // ─────────────────────────────────────────────────────────────

  ipcMainProxy.handle('agents-get-prompt-templates', async() => {
    const { soulPrompt } = require('@pkg/agent/prompts/soul');
    const { environmentPrompt } = require('@pkg/agent/prompts/environment');

    return { soul: soulPrompt, environment: environmentPrompt };
  });

  ipcMainProxy.handle('agents-list', async() => {
    const yaml = require('yaml');
    const agentsDir = path.join(getSullaHomeDir(), 'agents');

    if (!fs.existsSync(agentsDir)) return [];

    const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
    const agents: { id: string; name: string; description: string; type: string; templateId: string; path: string }[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const agentDir = path.join(agentsDir, entry.name);
      const yamlPath = path.join(agentDir, 'agent.yaml');

      if (!fs.existsSync(yamlPath)) continue;
      try {
        const content = fs.readFileSync(yamlPath, 'utf-8');
        const parsed = yaml.parse(content) || {};

        agents.push({
          id:          entry.name,
          name:        parsed.name || entry.name,
          description: parsed.description || '',
          type:        parsed.type || 'worker',
          templateId:  parsed.templateId || 'glass-core',
          path:        agentDir,
        });
      } catch (err) {
        console.warn(`[Sulla] Failed to parse agent.yaml in ${entry.name}:`, err);
      }
    }

    return agents;
  });

  ipcMainProxy.handle('agents-delete', async(_event: any, agentId: string) => {
    const agentsDir = path.join(getSullaHomeDir(), 'agents');
    const agentDir = path.join(agentsDir, agentId);

    // Safety: ensure the path is actually inside agents dir
    if (!agentDir.startsWith(agentsDir) || agentId.includes('..') || agentId.includes('/')) {
      throw new Error('Invalid agent ID');
    }

    if (!fs.existsSync(agentDir)) {
      throw new Error(`Agent directory not found: ${agentId}`);
    }

    fs.rmSync(agentDir, { recursive: true, force: true });

    return true;
  });

  ipcMainProxy.handle('agents-get-template-variables', async() => {
    const { resolveSullaHomeDir, resolveSullaProjectsDir, resolveSullaSkillsDir, resolveSullaWorkspacesDir, resolveSullaAgentsDir, resolveSullaWorkflowsDir } = require('@pkg/agent/utils/sullaPaths');
    const { SullaSettingsModel } = require('@pkg/agent/database/models/SullaSettingsModel');
    const nodePath = require('node:path');

    const projectsDir = resolveSullaProjectsDir();
    const botName = await SullaSettingsModel.get('botName', 'Sulla');
    const primaryUserName = await SullaSettingsModel.get('primaryUserName', '');

    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown';
    const formattedTime = now.toLocaleString('en-US', {
      timeZone: tz,
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
    });

    return [
      { key: '{{formattedTime}}',        label: 'Current Date/Time',     preview: formattedTime },
      { key: '{{timeZone}}',             label: 'Time Zone',             preview: tz },
      { key: '{{primaryUserName}}',      label: "Human's Name",          preview: primaryUserName || '(not set)' },
      { key: '{{botName}}',              label: 'Bot Name',              preview: botName },
      { key: '{{sulla_home}}',           label: 'Sulla Home Dir',        preview: resolveSullaHomeDir() },
      { key: '{{projects_dir}}',         label: 'Projects Dir',          preview: projectsDir },
      { key: '{{skills_dir}}',           label: 'Skills Dir',            preview: resolveSullaSkillsDir() },
      { key: '{{workspaces_dir}}',       label: 'Workspaces Dir',        preview: resolveSullaWorkspacesDir() },
      { key: '{{agents_dir}}',           label: 'Agents Dir',            preview: resolveSullaAgentsDir() },
      { key: '{{workflows_dir}}',        label: 'Workflows Dir',         preview: resolveSullaWorkflowsDir() },
      { key: '{{active_projects_file}}', label: 'Active Projects File',  preview: nodePath.join(projectsDir, 'ACTIVE_PROJECTS.md') },
      { key: '{{skills_index}}',         label: 'Skills Index',          preview: '(resolved at runtime)' },
      { key: '{{tool_categories}}',      label: 'Tool Categories',       preview: '(resolved at runtime)' },
      { key: '{{installed_extensions}}', label: 'Installed Extensions',  preview: '(resolved at runtime)' },
    ];
  });

  ipcMainProxy.handle('tools-list-by-category', async() => {
    // Ensure manifests are registered (side-effect import)
    require('@pkg/agent/tools/manifests');
    const { toolRegistry } = require('@pkg/agent/tools/registry');
    const categories = toolRegistry.getCategoriesWithDescriptions() as { category: string; description: string }[];
    const result: { category: string; description: string; tools: { name: string; description: string; operationTypes: string[] }[] }[] = [];

    for (const cat of categories) {
      const getMetadata = toolRegistry.getCategoryToolMetadata(cat.category);
      const tools: { name: string; description: string }[] = await getMetadata();
      if (tools.length > 0) {
        result.push({
          category:    cat.category,
          description: cat.description,
          tools:       tools.map(t => ({
            name:           t.name,
            description:    t.description,
            operationTypes: toolRegistry.getOperationTypes(t.name) as string[],
          })),
        });
      }
    }

    return result;
  });

  initSullaWorkflowEvents();

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

    if (isTrainingLocked()) {
      console.log('[Sulla] Skipping nightly training — another training run is already in progress');
      rescheduleNightlyTraining(true, hour, minute);
      return;
    }

    acquireTrainingLock();
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

      await service.runFullNightlyTraining(modelKey, logPath);
      fs.appendFileSync(logPath, `\n=== Completed: ${new Date().toISOString()} ===\n`, 'utf-8');
    } catch (err) {
      console.error('[Sulla] Nightly training failed:', err);
    } finally {
      releaseTrainingLock();
    }

    // Re-arm for the next day
    rescheduleNightlyTraining(true, hour, minute);
  }, delayMs);

  // Don't keep the app alive just for this timer
  nightlyTrainingTimer.unref();
}
