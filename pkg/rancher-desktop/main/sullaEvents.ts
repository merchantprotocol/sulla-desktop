/**
 * Sulla-specific IPC event handlers for the Agent UI.
 */

import * as fs from 'fs';
import * as path from 'path';

import { getIpcMainProxy } from '@pkg/main/ipcMain';
import Logging from '@pkg/utils/logging';
import { initSullaWorkflowEvents } from './sullaWorkflowEvents';
import { initSullaDebugEvents } from './sullaDebugEvents';

const console = Logging.background;
const ipcMainProxy = getIpcMainProxy(console);

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
  // Settings handlers
  // ─────────────────────────────────────────────────────────────

  ipcMainProxy.handle('sulla-settings-get', async (_event: unknown, property: string, defaultValue: any = null) => {
    const { SullaSettingsModel } = await import('@pkg/agent/database/models/SullaSettingsModel');

    return SullaSettingsModel.get(property, defaultValue);
  });

  ipcMainProxy.handle('sulla-settings-set', async (_event: unknown, property: string, value: any) => {
    const { SullaSettingsModel } = await import('@pkg/agent/database/models/SullaSettingsModel');

    await SullaSettingsModel.set(property, value);
  });

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

  ipcMainProxy.handle('training-run', async(_event: unknown, modelKey: string, sources: { documentProcessing: boolean; loraTraining: boolean; skills: boolean }) => {
    const tc = await import('./trainingController');
    return tc.runTraining(modelKey, sources);
  });

  ipcMainProxy.handle('training-status', async() => {
    const tc = await import('./trainingController');
    return tc.getTrainingStatus();
  });

  ipcMainProxy.handle('training-history', async() => {
    const tc = await import('./trainingController');
    return tc.getTrainingHistory();
  });

  ipcMainProxy.handle('training-log-read', async(_event: unknown, filename: string) => {
    const tc = await import('./trainingController');
    return tc.readTrainingLog(filename);
  });

  ipcMainProxy.handle('training-schedule-get', async() => {
    const tc = await import('./trainingController');
    return tc.getSchedule();
  });

  ipcMainProxy.handle('training-models-downloaded', async() => {
    const tc = await import('./trainingController');
    return tc.getDownloadedTrainingModels();
  });

  ipcMainProxy.handle('training-schedule-set', async(_event: unknown, opts: { enabled: boolean; hour: number; minute: number }) => {
    const tc = await import('./trainingController');
    return tc.setSchedule(opts);
  });

  // On startup, load the schedule and arm the timer + auto-preprocessing
  import('./trainingController').then(tc => tc.initScheduleOnStartup()).catch(() => {});

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

  ipcMainProxy.handle('training-docs-config-exists', async() => {
    const tc = await import('./trainingController');
    return tc.docsConfigExists();
  });

  ipcMainProxy.handle('training-docs-config-load', async() => {
    const tc = await import('./trainingController');
    return tc.docsConfigLoad();
  });

  ipcMainProxy.handle('training-docs-list-dir', async(_event: unknown, dirPath: string) => {
    const tc = await import('./trainingController');
    return tc.docsListDir(dirPath);
  });

  ipcMainProxy.handle('training-content-tree', async(_event: unknown, dirPath?: string) => {
    const tc = await import('./trainingController');
    return tc.contentTree(dirPath);
  });

  ipcMainProxy.handle('training-docs-config-save', async(_event: unknown, folders: string[], files: string[], fileTypes: string[]) => {
    const tc = await import('./trainingController');
    return tc.docsConfigSave(folders, files, fileTypes);
  });

  // ── Training Environment Installation ────────────────────────────

  ipcMainProxy.handle('training-install-status', async() => {
    const tc = await import('./trainingController');
    return tc.getFullInstallStatus();
  });

  /**
   * Lightweight stats for the editor footer:
   * - availableBytes: free disk space on the userData volume
   * - unprocessedTrainingBytes: total size of unprocessed .jsonl session files
   */
  ipcMainProxy.handle('editor-footer-stats', async() => {
    let availableBytes = 0;

    try {
      const { statfsSync } = await import('fs');
      const { app } = await import('electron');
      const stats = statfsSync(app.getPath('userData'));

      availableBytes = stats.bavail * stats.bsize;
    } catch {
      availableBytes = 0;
    }

    let unprocessedTrainingBytes = 0;

    try {
      const { resolveSullaTrainingDir } = await import('@pkg/agent/utils/sullaPaths');
      const fs = await import('fs');
      const path = await import('path');
      const dir = resolveSullaTrainingDir();

      if (fs.existsSync(dir)) {
        const entries = fs.readdirSync(dir);

        for (const name of entries) {
          if (name.endsWith('.jsonl')) {
            try {
              const stat = fs.statSync(path.join(dir, name));

              unprocessedTrainingBytes += stat.size;
            } catch { /* skip */ }
          }
        }
      }
    } catch { /* skip */ }

    return { availableBytes, unprocessedTrainingBytes };
  });

  ipcMainProxy.handle('training-data-files', async() => {
    const tc = await import('./trainingController');
    return tc.listTrainingDataFiles();
  });

  ipcMainProxy.handle('training-preprocess', async() => {
    const tc = await import('./trainingController');
    return tc.preprocessNow();
  });

  ipcMainProxy.handle('training-prepare-docs', async(_event: unknown, folders: string[], files: string[], options?: { prompt: string; modelId: string; modelProvider: string; outputFilename: string }) => {
    const tc = await import('./trainingController');
    return tc.prepareDocs(folders, files, options);
  });

  // ─── Training Queue IPC ───

  ipcMainProxy.handle('training-queue-add', async(_event: unknown, entries: Array<{ filePath: string; prompt: string; modelId: string; modelProvider: string; outputFilename: string }>) => {
    const tc = await import('./trainingController');
    return tc.addToQueue(entries);
  });

  ipcMainProxy.handle('training-queue-process-now', async() => {
    const tc = await import('./trainingController');
    return tc.processQueueNow();
  });

  ipcMainProxy.handle('training-queue-status', async() => {
    const tc = await import('./trainingController');
    return tc.getQueueStatus();
  });

  // ─── Train on Conversations Now ───

  ipcMainProxy.handle('training-train-conversations-now', async() => {
    const tc = await import('./trainingController');
    return tc.trainConversationsNow();
  });

  // ─── Scheduled Training Configs ───

  ipcMainProxy.handle('training-scheduled-configs-list', async() => {
    const tc = await import('./trainingController');
    return tc.listScheduledConfigs();
  });

  ipcMainProxy.handle('training-scheduled-configs-add', async(_event: unknown, config: { name: string; source: string; modelKey: string; prompt?: string; outputFilename?: string; files?: string[] }) => {
    const tc = await import('./trainingController');
    return tc.addScheduledConfig(config);
  });

  ipcMainProxy.handle('training-scheduled-configs-remove', async(_event: unknown, id: string) => {
    const tc = await import('./trainingController');
    return tc.removeScheduledConfig(id);
  });

  // ─── Wizard Settings Persistence ───

  ipcMainProxy.handle('training-wizard-settings-save', async(_event: unknown, wizard: 'create' | 'train', settings: Record<string, unknown>) => {
    const tc = await import('./trainingController');
    return tc.saveWizardSettings(wizard, settings);
  });

  ipcMainProxy.handle('training-wizard-settings-load', async(_event: unknown, wizard: 'create' | 'train') => {
    const tc = await import('./trainingController');
    return tc.loadWizardSettings(wizard);
  });

  ipcMainProxy.handle('training-install', async() => {
    const tc = await import('./trainingController');
    return tc.installTrainingEnv();
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
  initSullaDebugEvents();

  // ── Integration Config API (YAML-defined integrations) ──────────

  /** List available integrations and their endpoints */
  ipcMainProxy.handle('configapi-list-integrations', async () => {
    const { getIntegrationConfigLoader } = await import('@pkg/agent/integrations/configApi');
    const loader = getIntegrationConfigLoader();
    const names = loader.getAvailableIntegrations();

    return names.map((slug) => {
      const integration = loader.getIntegration(slug);
      if (!integration) return null;

      const endpoints = [...integration.endpoints.entries()].map(([name, ep]) => ({
        name,
        path:        ep.endpoint.path,
        method:      ep.endpoint.method,
        description: ep.endpoint.description,
        auth:        ep.endpoint.auth,
        queryParams: ep.query_params ? Object.entries(ep.query_params).map(([k, v]) => ({
          key: k, ...v,
        })) : [],
      }));

      return {
        slug,
        name:    integration.auth.api.name,
        baseUrl: integration.auth.api.base_url,
        version: integration.auth.api.version,
        endpoints,
      };
    }).filter(Boolean);
  });

  /** Reload integrations from disk */
  ipcMainProxy.handle('configapi-reload', async () => {
    const { getIntegrationConfigLoader } = await import('@pkg/agent/integrations/configApi');
    const loader = getIntegrationConfigLoader();
    await loader.loadAll();
    return loader.getAvailableIntegrations();
  });

  /** Execute an API call through a YAML-configured integration */
  ipcMainProxy.handle('configapi-call', async (
    _event: unknown,
    slug: string,
    endpointName: string,
    params: Record<string, any>,
    options?: { token?: string; apiKey?: string; body?: unknown; raw?: boolean },
  ) => {
    const { getIntegrationConfigLoader } = await import('@pkg/agent/integrations/configApi');
    const loader = getIntegrationConfigLoader();
    const client = loader.getClient(slug);
    if (!client) {
      throw new Error(`Integration "${slug}" not found`);
    }

    const result = await client.call(endpointName, params, options || {});
    return JSON.parse(JSON.stringify(result)); // ensure serializable
  });

  console.log('[Sulla] IPC event handlers initialized');
}

// Nightly training schedule, auto-preprocessing, and related timers
// have been moved to trainingController.ts
