/**
 * Sulla-specific IPC event handlers for the Agent UI.
 */

import * as fs from 'fs';
import * as path from 'path';

import { initTabsIpc } from './browserTabs/tabsIpc';
import { initClaudeCodeTestEvents } from './claudeCodeTest';
import { initClaudeOAuthEvents } from './claudeOAuth';
import { initDesktopRelayEvents } from './desktopRelay';
import { initSullaCloudAuthEvents } from './sullaCloudAuth';
import { initConversationHistoryIpc } from './conversationHistoryIpc';
import { initMessageBusIpc } from './messageBusIpc';
import { initSullaBundleEvents } from './sullaBundleEvents';
import { initSullaDebugEvents } from './sullaDebugEvents';
import { initSullaFunctionEvents } from './sullaFunctionEvents';
import { initSullaLibraryDraftEvents } from './sullaLibraryDraftEvents';
import { initSullaLibraryEvents } from './sullaLibraryEvents';
import { initSullaMarketplaceEvents } from './sullaMarketplaceEvents';
import { initSullaProjectEvents } from './sullaProjectEvents';
import { initSullaRoutineExportEvents } from './sullaRoutineExportEvents';
import { initSullaRoutineImportEvents } from './sullaRoutineImportEvents';
import { initSullaRoutineTemplateEvents } from './sullaRoutineTemplateEvents';
import { initSullaWorkflowEvents } from './sullaWorkflowEvents';

import { getIpcMainProxy } from '@pkg/main/ipcMain';
import Logging from '@pkg/utils/logging';

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
    throw new Error(`Path is outside sulla home: ${ resolved }`);
  }
  return resolved;
}

/**
 * Initialize Sulla-specific IPC handlers.
 */
export function initSullaEvents(): void {
  initMessageBusIpc();
  initTabsIpc();
  initConversationHistoryIpc();
  initClaudeOAuthEvents();
  initClaudeCodeTestEvents();
  initDesktopRelayEvents();
  initSullaCloudAuthEvents();

  // ─────────────────────────────────────────────────────────────
  // Settings handlers
  // ─────────────────────────────────────────────────────────────

  ipcMainProxy.handle('sulla-settings-get', async(_event: unknown, property: string, defaultValue: any = null) => {
    const { SullaSettingsModel } = await import('@pkg/agent/database/models/SullaSettingsModel');

    return SullaSettingsModel.get(property, defaultValue);
  });

  ipcMainProxy.handle('sulla-settings-set', async(_event: unknown, property: string, value: any, cast?: string) => {
    const { SullaSettingsModel } = await import('@pkg/agent/database/models/SullaSettingsModel');

    await SullaSettingsModel.set(property, value, cast);
  });

  ipcMainProxy.handle('sulla-settings-delete', async(_event: unknown, property: string) => {
    const { SullaSettingsModel } = await import('@pkg/agent/database/models/SullaSettingsModel');

    await SullaSettingsModel.delete(property);
  });

  // ─────────────────────────────────────────────────────────────
  // Filesystem handlers
  // ─────────────────────────────────────────────────────────────

  ipcMainProxy.handle('filesystem-get-root', async() => {
    const root = getSullaHomeDir();
    fs.mkdirSync(root, { recursive: true });
    return root;
  });

  ipcMainProxy.handle('filesystem-get-git-changes', async(event, path) => {
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
  ipcMainProxy.handle('git-discover-repos', async(_event: unknown, dirPath: string) => {
    const { execSync } = require('child_process');
    const repoRoots = new Set<string>();
    const results: { root: string; name: string }[] = [];

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

  ipcMainProxy.handle('git-branch', async(_event: unknown, dirPath: string) => {
    const { execSync } = require('child_process');
    try {
      return execSync('git rev-parse --abbrev-ref HEAD', { cwd: dirPath, encoding: 'utf8', stdio: 'pipe' }).trim();
    } catch {
      return '';
    }
  });

  ipcMainProxy.handle('git-list-branches', async(_event: unknown, dirPath: string) => {
    const { execSync } = require('child_process');
    try {
      const output = execSync('git branch -a --no-color', { cwd: dirPath, encoding: 'utf8', stdio: 'pipe' });
      const branches: { name: string; current: boolean; remote: boolean }[] = [];
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

  ipcMainProxy.handle('git-checkout-branch', async(_event: unknown, dirPath: string, branchName: string) => {
    const { execSync } = require('child_process');
    try {
      execSync(`git checkout "${ branchName }"`, { cwd: dirPath, encoding: 'utf8', stdio: 'pipe' });
      return { success: true, error: '' };
    } catch (err: any) {
      return { success: false, error: err.stderr || err.message };
    }
  });

  ipcMainProxy.handle('git-create-branch', async(_event: unknown, dirPath: string, branchName: string) => {
    const { execSync } = require('child_process');
    try {
      execSync(`git checkout -b "${ branchName }"`, { cwd: dirPath, encoding: 'utf8', stdio: 'pipe' });
      return { success: true, error: '' };
    } catch (err: any) {
      return { success: false, error: err.stderr || err.message };
    }
  });

  ipcMainProxy.handle('git-status-full', async(_event: unknown, dirPath: string) => {
    const { execSync } = require('child_process');
    try {
      const output = execSync('git status --porcelain -uall', { cwd: dirPath, encoding: 'utf8', stdio: 'pipe' });
      console.log('[git-status-full] raw output for', dirPath, ':\n', JSON.stringify(output));
      const lines = output.split('\n').filter((line: string) => line.trim());
      console.log('[git-status-full] parsed lines count:', lines.length);
      const entries = lines.map((line: string) => {
        const index = line[0];
        const worktree = line[1];
        let file = line.slice(3);
        // Strip trailing slash from directory entries
        if (file.endsWith('/')) {
          file = file.slice(0, -1);
        }
        console.log('[git-status-full] entry:', JSON.stringify({ index, worktree, file, rawLine: line }));
        return { index, worktree, file };
      });
      return entries;
    } catch (err: any) {
      console.error('[git-status-full] error for', dirPath, ':', err.message);
      return [];
    }
  });

  ipcMainProxy.handle('git-stage', async(_event: unknown, dirPath: string, files: string[]) => {
    const { execSync } = require('child_process');
    try {
      const fileArgs = files.map((f: string) => `"${ f }"`).join(' ');
      execSync(`git add ${ fileArgs }`, { cwd: dirPath, encoding: 'utf8', stdio: 'pipe' });
      return true;
    } catch (err: any) {
      console.error('[git-stage] Error:', err.message);
      return false;
    }
  });

  ipcMainProxy.handle('git-unstage', async(_event: unknown, dirPath: string, files: string[]) => {
    const { execSync } = require('child_process');
    try {
      const fileArgs = files.map((f: string) => `"${ f }"`).join(' ');
      execSync(`git reset HEAD ${ fileArgs }`, { cwd: dirPath, encoding: 'utf8', stdio: 'pipe' });
      return true;
    } catch (err: any) {
      console.error('[git-unstage] Error:', err.message);
      return false;
    }
  });

  ipcMainProxy.handle('git-diff', async(_event: unknown, dirPath: string, file: string, staged: boolean) => {
    const { execSync } = require('child_process');
    try {
      const cmd = staged ? `git diff --cached "${ file }"` : `git diff "${ file }"`;
      return execSync(cmd, { cwd: dirPath, encoding: 'utf8', stdio: 'pipe' });
    } catch {
      return '';
    }
  });

  // Get the HEAD (committed) version of a file for diff comparison
  ipcMainProxy.handle('git-show-head', async(_event: unknown, dirPath: string, file: string) => {
    const { execSync } = require('child_process');
    try {
      return execSync(`git show HEAD:"${ file }"`, { cwd: dirPath, encoding: 'utf8', stdio: 'pipe' });
    } catch {
      return '';
    }
  });

  // Get the staged version of a file for diff comparison
  ipcMainProxy.handle('git-show-staged', async(_event: unknown, dirPath: string, file: string) => {
    const { execSync } = require('child_process');
    try {
      return execSync(`git show :"${ file }"`, { cwd: dirPath, encoding: 'utf8', stdio: 'pipe' });
    } catch {
      return '';
    }
  });

  ipcMainProxy.handle('git-commit', async(_event: unknown, dirPath: string, message: string) => {
    const { execSync } = require('child_process');
    try {
      const escaped = message.replace(/"/g, '\\"');
      execSync(`git commit -m "${ escaped }"`, { cwd: dirPath, encoding: 'utf8', stdio: 'pipe' });
      return true;
    } catch (err: any) {
      console.error('[git-commit] Error:', err.message);
      return false;
    }
  });

  ipcMainProxy.handle('git-pull', async(_event: unknown, dirPath: string) => {
    const { execSync } = require('child_process');
    try {
      const output = execSync('git pull', { cwd: dirPath, encoding: 'utf8', stdio: 'pipe', timeout: 60_000 });
      return { success: true, output: output.trim() };
    } catch (err: any) {
      return { success: false, output: err.stderr || err.message };
    }
  });

  ipcMainProxy.handle('git-push', async(_event: unknown, dirPath: string) => {
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

  ipcMainProxy.handle('git-fetch', async(_event: unknown, dirPath: string) => {
    const { execSync } = require('child_process');
    try {
      execSync('git fetch --all', { cwd: dirPath, encoding: 'utf8', stdio: 'pipe', timeout: 60_000 });
      return { success: true, output: 'Fetched all remotes.' };
    } catch (err: any) {
      return { success: false, output: err.stderr || err.message };
    }
  });

  ipcMainProxy.handle('git-stash', async(_event: unknown, dirPath: string) => {
    const { execSync } = require('child_process');
    try {
      const output = execSync('git stash', { cwd: dirPath, encoding: 'utf8', stdio: 'pipe' });
      return { success: true, output: output.trim() };
    } catch (err: any) {
      return { success: false, output: err.stderr || err.message };
    }
  });

  ipcMainProxy.handle('git-stash-pop', async(_event: unknown, dirPath: string) => {
    const { execSync } = require('child_process');
    try {
      const output = execSync('git stash pop', { cwd: dirPath, encoding: 'utf8', stdio: 'pipe' });
      return { success: true, output: output.trim() };
    } catch (err: any) {
      return { success: false, output: err.stderr || err.message };
    }
  });

  ipcMainProxy.handle('git-discard-all', async(_event: unknown, dirPath: string) => {
    const { execSync } = require('child_process');
    try {
      execSync('git checkout -- .', { cwd: dirPath, encoding: 'utf8', stdio: 'pipe' });
      execSync('git clean -fd', { cwd: dirPath, encoding: 'utf8', stdio: 'pipe' });
      return { success: true, output: 'Discarded all changes.' };
    } catch (err: any) {
      return { success: false, output: err.stderr || err.message };
    }
  });

  ipcMainProxy.handle('git-add-gitignore', async(_event: unknown, repoRoot: string, pattern: string) => {
    try {
      const gitignorePath = path.join(repoRoot, '.gitignore');
      let content = '';
      try { content = fs.readFileSync(gitignorePath, 'utf8') } catch { /* file may not exist */ }
      // Check if pattern already exists
      const lines = content.split('\n');
      if (lines.some(l => l.trim() === pattern.trim())) {
        return { success: true, output: 'Pattern already in .gitignore' };
      }
      // Append pattern
      const newContent = content.endsWith('\n') || content === '' ? content + pattern + '\n' : content + '\n' + pattern + '\n';
      fs.writeFileSync(gitignorePath, newContent, 'utf8');
      return { success: true, output: `Added "${ pattern }" to .gitignore` };
    } catch (err: any) {
      return { success: false, output: err.message };
    }
  });

  ipcMainProxy.handle('filesystem-read-dir', async(_event: unknown, dirPath: string) => {
    console.log('[filesystem-read-dir] reading:', dirPath);
    const resolved = assertInsideSullaHome(dirPath);
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const result = entries
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
    console.log('[filesystem-read-dir] returned', result.length, 'entries for', dirPath, ':', result.map(e => `${ e.isDir ? 'D' : 'F' } ${ e.name }`).join(', '));
    return result;
  });

  ipcMainProxy.handle('filesystem-read-file', async(_event: unknown, filePath: string) => {
    const resolved = assertInsideSullaHome(filePath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`File not found: ${ resolved }`);
    }
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      throw new Error('Cannot read a directory as a file');
    }
    if (stat.size > 5 * 1024 * 1024) {
      throw new Error('File too large to open (>5MB)');
    }
    return fs.readFileSync(resolved, 'utf-8');
  });

  ipcMainProxy.handle('filesystem-write-file', async(_event: unknown, filePath: string, content: string) => {
    const resolved = assertInsideSullaHome(filePath);
    fs.writeFileSync(resolved, content, 'utf-8');
  });

  ipcMainProxy.handle('filesystem-save-dialog', async(_event: unknown, defaultName: string, defaultPath?: string) => {
    const { dialog } = require('electron');
    const result = await dialog.showSaveDialog({
      title:       'Save File',
      defaultPath: defaultPath ? path.join(defaultPath, defaultName) : defaultName,
      properties:  ['createDirectory', 'showOverwriteConfirmation'],
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
    if (fs.existsSync(filePath)) throw new Error(`File already exists: ${ fileName }`);
    fs.writeFileSync(filePath, '', 'utf-8');
    return filePath;
  });

  ipcMainProxy.handle('filesystem-create-dir', async(_event: unknown, dirPath: string, dirName: string) => {
    const dir = assertInsideSullaHome(dirPath);
    const newDir = path.join(dir, dirName);
    assertInsideSullaHome(newDir);
    if (fs.existsSync(newDir)) throw new Error(`Directory already exists: ${ dirName }`);
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
        target = path.join(resolvedDest, `${ stem } (${ i })${ ext }`);
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
    if (fs.existsSync(target)) throw new Error(`"${ baseName }" already exists in destination`);
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
        target = path.join(dir, `${ stem } (${ i })${ ext }`);
        i++;
      }
    }

    const buffer = Buffer.from(base64Data, 'base64');
    fs.writeFileSync(target, buffer);
    return target;
  });

  /**
   * Return system resource info for the renderer's fitness indicators.
   */
  ipcMainProxy.handle('system-resources', async() => {
    const os = require('os');
    const totalMemoryGB = Math.round((os.totalmem() / (1024 ** 3)) * 10) / 10;
    const freeMemoryGB = Math.round((os.freemem() / (1024 ** 3)) * 10) / 10;

    let availableDiskGB = 0;

    try {
      const { execSync } = require('child_process');
      const { app } = require('electron');
      const userDataPath = app.getPath('userData');
      const dfOutput = execSync(`df -k "${ userDataPath }"`, { encoding: 'utf-8' });
      const lines = dfOutput.trim().split('\n');

      if (lines.length >= 2) {
        const parts = lines[1].split(/\s+/);
        const availKB = parseInt(parts[3], 10);

        if (!isNaN(availKB)) {
          availableDiskGB = Math.round((availKB / (1024 ** 2)) * 10) / 10;
        }
      }
    } catch {
      // Ignore disk space check failures
    }

    return { totalMemoryGB, availableMemoryGB: freeMemoryGB, availableDiskGB };
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

  ipcMainProxy.handle('docker-list-containers', async() => {
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
      const yamlPath = path.join(agentDir, 'config.yaml');

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
        console.warn(`[Sulla] Failed to parse config.yaml in ${ entry.name }:`, err);
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
      throw new Error(`Agent directory not found: ${ agentId }`);
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
      weekday:  'long',
      year:     'numeric',
      month:    'long',
      day:      'numeric',
      hour:     '2-digit',
      minute:   '2-digit',
      second:   '2-digit',
      hour12:   true,
    });

    return [
      { key: '{{formattedTime}}', label: 'Current Date/Time', preview: formattedTime },
      { key: '{{timeZone}}', label: 'Time Zone', preview: tz },
      { key: '{{primaryUserName}}', label: "Human's Name", preview: primaryUserName || '(not set)' },
      { key: '{{botName}}', label: 'Bot Name', preview: botName },
      { key: '{{sulla_home}}', label: 'Sulla Home Dir', preview: resolveSullaHomeDir() },
      { key: '{{projects_dir}}', label: 'Projects Dir', preview: projectsDir },
      { key: '{{skills_dir}}', label: 'Skills Dir', preview: resolveSullaSkillsDir() },
      { key: '{{workspaces_dir}}', label: 'Workspaces Dir', preview: resolveSullaWorkspacesDir() },
      { key: '{{agents_dir}}', label: 'Agents Dir', preview: resolveSullaAgentsDir() },
      { key: '{{workflows_dir}}', label: 'Workflows Dir', preview: resolveSullaWorkflowsDir() },
      { key: '{{active_projects_file}}', label: 'Active Projects File', preview: nodePath.join(projectsDir, 'ACTIVE_PROJECTS.md') },
      { key: '{{skills_index}}', label: 'Skills Index', preview: '(resolved at runtime)' },
      { key: '{{tool_categories}}', label: 'Tool Categories', preview: '(resolved at runtime)' },
      { key: '{{installed_extensions}}', label: 'Installed Extensions', preview: '(resolved at runtime)' },
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

  ipcMainProxy.handle('tools-get-schema', async(_event: any, toolName: string) => {
    require('@pkg/agent/tools/manifests');
    const { toolRegistry } = require('@pkg/agent/tools/registry');
    const schemaDef = toolRegistry.getSchemaDef(toolName);

    return schemaDef || null;
  });

  initSullaWorkflowEvents();
  initSullaRoutineTemplateEvents();
  initSullaRoutineExportEvents();
  initSullaRoutineImportEvents();
  initSullaBundleEvents();
  initSullaMarketplaceEvents();
  initSullaLibraryEvents();
  initSullaLibraryDraftEvents();
  initSullaDebugEvents();
  initSullaFunctionEvents();
  initSullaProjectEvents();

  // ── Integration Config API (YAML-defined integrations) ──────────

  /** List available integrations and their endpoints */
  ipcMainProxy.handle('configapi-list-integrations', async() => {
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
        queryParams: ep.query_params
          ? Object.entries(ep.query_params).map(([k, v]) => ({
            key: k, ...v,
          }))
          : [],
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
  ipcMainProxy.handle('configapi-reload', async() => {
    const { getIntegrationConfigLoader } = await import('@pkg/agent/integrations/configApi');
    const loader = getIntegrationConfigLoader();
    await loader.loadAll();
    return loader.getAvailableIntegrations();
  });

  /** Execute an API call through a YAML-configured integration */
  ipcMainProxy.handle('configapi-call', async(
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
      throw new Error(`Integration "${ slug }" not found`);
    }

    const result = await client.call(endpointName, params, options || {});
    return JSON.parse(JSON.stringify(result)); // ensure serializable
  });

  // ─────────────────────────────────────────────────────────────
  // Audio / Transcription handlers
  // ─────────────────────────────────────────────────────────────

  // NOTE: audio-transcribe handler removed — transcription is now handled
  // by the audio-driver's gateway.js service (streams audio directly to
  // the transcription gateway via WebSocket).

  ipcMainProxy.handle('audio-speak', async(_event: unknown, payload: { text: string; voiceId?: string }) => {
    const { getTextToSpeechService } = await import('@pkg/agent/services/TextToSpeechService');
    const service = getTextToSpeechService();
    const result = await service.speak(payload.text, payload.voiceId);

    // Return ArrayBuffer so it can be played in the renderer
    const ab = result.audio.buffer.slice(result.audio.byteOffset, result.audio.byteOffset + result.audio.byteLength);

    return {
      audio:    ab as ArrayBuffer,
      mimeType: result.mimeType,
    };
  });

  // ─────────────────────────────────────────────────────────────
  // Desktop gateway session lifecycle (secretary mode → GhostAgent)
  // ─────────────────────────────────────────────────────────────

  ipcMainProxy.handle('desktop-session-start', async(_event: unknown, payload?: { callerName?: string }) => {
    try {
      const { getIntegrationService } = await import('@pkg/agent/services/IntegrationService');
      const integrationService = getIntegrationService();

      const [urlValue, keyValue] = await Promise.all([
        integrationService.getIntegrationValue('enterprise_gateway', 'gateway_url'),
        integrationService.getIntegrationValue('enterprise_gateway', 'api_key'),
      ]);

      const gatewayUrl = urlValue?.value?.trim();
      const apiKey = keyValue?.value?.trim();
      if (!gatewayUrl || !apiKey) {
        return { sessionId: null, error: 'Gateway not configured' };
      }

      const response = await fetch(`${ gatewayUrl.replace(/\/+$/, '') }/api/desktop/sessions`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          Authorization:  `Bearer ${ apiKey }`,
        },
        body: JSON.stringify({ callerName: payload?.callerName || 'Sulla Secretary' }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        console.error(`[Desktop] Gateway session start failed (${ response.status }): ${ body }`);

        return { sessionId: null, error: `Gateway returned ${ response.status }: ${ body }` };
      }

      const result = await response.json() as { sessionId: string; callId: string };
      console.log(`[Desktop] Gateway session started: ${ result.sessionId }`);

      return result;
    } catch (err: any) {
      console.error('[Desktop] desktop-session-start failed:', err.message);

      return { sessionId: null, error: err.message };
    }
  });

  ipcMainProxy.handle('desktop-session-end', async(_event: unknown, sessionId: string) => {
    if (!sessionId) return { ok: false, error: 'No session ID' };

    try {
      const { getIntegrationService } = await import('@pkg/agent/services/IntegrationService');
      const integrationService = getIntegrationService();

      const [urlValue, keyValue] = await Promise.all([
        integrationService.getIntegrationValue('enterprise_gateway', 'gateway_url'),
        integrationService.getIntegrationValue('enterprise_gateway', 'api_key'),
      ]);

      const gatewayUrl = urlValue?.value?.trim();
      const apiKey = keyValue?.value?.trim();
      if (!gatewayUrl || !apiKey) {
        console.warn(`[Desktop] Cannot end session ${ sessionId } — gateway not configured`);

        return { ok: false, error: 'Gateway not configured' };
      }

      const resp = await fetch(`${ gatewayUrl.replace(/\/+$/, '') }/api/desktop/sessions/${ sessionId }`, {
        method:  'DELETE',
        headers: { Authorization: `Bearer ${ apiKey }` },
      });

      if (!resp.ok) {
        console.warn(`[Desktop] Session DELETE returned ${ resp.status } for ${ sessionId }`);
      }

      console.log(`[Desktop] Gateway session ended: ${ sessionId }`);

      return { ok: true };
    } catch (err: any) {
      console.error(`[Desktop] desktop-session-end failed for ${ sessionId }:`, err.message);

      return { ok: false, error: err.message };
    }
  });

  // ─────────────────────────────────────────────────────────────
  // Gateway Listener — lobby WebSocket + audio streaming
  // ─────────────────────────────────────────────────────────────

  let audioSendErrCount = 0; // rate-limit audio-send error logging

  // ─────────────────────────────────────────────────────────────
  // Gateway — all IPC handlers delegate to GatewayConnectionController
  // ─────────────────────────────────────────────────────────────

  ipcMainProxy.handle('gateway-listener-start', async() => {
    try {
      const { getGatewayConnectionController } = await import('@pkg/agent/controllers/GatewayConnectionController');
      await getGatewayConnectionController().startLobby();

      return { ok: true };
    } catch (err: any) {
      console.error('[Sulla] gateway-listener-start failed:', err.message);

      return { ok: false, error: err.message };
    }
  });

  ipcMainProxy.handle('gateway-listener-stop', async() => {
    try {
      const { getGatewayConnectionController } = await import('@pkg/agent/controllers/GatewayConnectionController');
      await getGatewayConnectionController().stopLobby();

      return { ok: true };
    } catch (err: any) {
      console.error('[Sulla] gateway-listener-stop failed:', err.message);

      return { ok: false, error: err.message };
    }
  });

  ipcMainProxy.handle('gateway-listener-status', async() => {
    try {
      const { getGatewayConnectionController } = await import('@pkg/agent/controllers/GatewayConnectionController');

      return await getGatewayConnectionController().getStatus();
    } catch (err: any) {
      console.error('[Sulla] gateway-listener-status failed:', err.message);

      return { lobbyConnected: false, audioConnected: false, sessionId: null, callId: null, error: err.message, lobbyReconnectAttempts: 0, audioReconnecting: false };
    }
  });

  ipcMainProxy.handle('gateway-audio-start', async(_event: unknown, payload?: { callerName?: string; channels?: Record<string, { label: string; source: string }> }) => {
    const { getGatewayConnectionController } = await import('@pkg/agent/controllers/GatewayConnectionController');
    const controller = getGatewayConnectionController();
    controller.resetAudioCount();

    try {
      const options = payload?.channels ? { channels: payload.channels } : undefined;
      const result = await controller.startAudioSession(payload?.callerName, options);

      return { sessionId: result.sessionId, callId: result.callId, error: null };
    } catch (err: any) {
      console.error('[Sulla] Gateway audio start failed:', err.message);

      return { sessionId: null, callId: null, error: err.message };
    }
  });

  ipcMainProxy.handle('gateway-audio-stop', async() => {
    try {
      const { getGatewayConnectionController } = await import('@pkg/agent/controllers/GatewayConnectionController');
      await getGatewayConnectionController().stopAudioSession();

      return { ok: true };
    } catch (err: any) {
      console.error('[Sulla] gateway-audio-stop failed:', err.message);

      return { ok: false, error: err.message };
    }
  });

  ipcMainProxy.handle('gateway-audio-send', async(_event: unknown, payload: { audio: ArrayBuffer; channel?: number }) => {
    try {
      const { getGatewayConnectionController } = await import('@pkg/agent/controllers/GatewayConnectionController');
      await getGatewayConnectionController().sendAudioChunk(payload.audio, payload.channel ?? 0);

      return { ok: true };
    } catch (err: any) {
      // Rate-limit audio send error logging — don't spam on every chunk
      audioSendErrCount++;
      if (audioSendErrCount <= 3 || audioSendErrCount % 100 === 0) {
        console.error(`[Sulla] gateway-audio-send failed (#${ audioSendErrCount }): ${ err.message }`);
      }

      return { ok: false, error: err.message };
    }
  });

  // ─────────────────────────────────────────────────────────────
  // Audio Driver — local transport (speaker audio from audio-driver)
  // ─────────────────────────────────────────────────────────────

  ipcMainProxy.handle('audio-driver-connect', async() => {
    try {
      const { getAudioDriverClient } = await import('@pkg/agent/services/AudioDriverClient');
      const client = getAudioDriverClient();

      if (client.connected) {
        return { ok: true, alreadyConnected: true };
      }

      // Wire incoming speaker chunks to the gateway
      client.removeAllListeners('chunk');
      let speakerChunkCount = 0;

      client.on('chunk', async(chunk: { source: string; channel: number; audio: Buffer }) => {
        if (chunk.source === 'speaker') {
          speakerChunkCount++;
          if (speakerChunkCount <= 5 || speakerChunkCount % 100 === 0) {
            console.log(`[Sulla] audio-driver speaker chunk #${ speakerChunkCount } (${ chunk.audio.length } bytes)`);
          }
          try {
            const { getGatewayConnectionController } = await import('@pkg/agent/controllers/GatewayConnectionController');

            await getGatewayConnectionController().sendAudioChunk(chunk.audio, 1);
          } catch {
            // Gateway not active — ignore
          }
        }
      });

      // connect() now auto-starts the daemon if it's not running
      await client.connect();

      return { ok: true };
    } catch (err: any) {
      console.error('[Sulla] audio-driver-connect failed:', err.message);

      return { ok: false, error: err.message };
    }
  });

  ipcMainProxy.handle('audio-driver-disconnect', async() => {
    try {
      const { getAudioDriverClient } = await import('@pkg/agent/services/AudioDriverClient');
      getAudioDriverClient().disconnect();

      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  });

  ipcMainProxy.handle('audio-driver-status', async() => {
    try {
      const fs = await import('fs');
      const { getAudioDriverClient } = await import('@pkg/agent/services/AudioDriverClient');
      const socketPath = process.platform === 'win32' ? '\\\\.\\pipe\\audio-driver' : '/tmp/audio-driver.sock';
      let installed = false;
      let socketExists = false;

      try {
        fs.accessSync('/usr/local/bin/audio-driver', fs.constants.X_OK);
        installed = true;
      } catch { /* not installed */ }

      try {
        socketExists = fs.statSync(socketPath).isSocket();
      } catch { /* no socket */ }

      return { connected: getAudioDriverClient().connected, installed, socketExists };
    } catch {
      return { connected: false, installed: false, socketExists: false };
    }
  });

  // ─────────────────────────────────────────────────────────────
  // Gateway transcript forwarding — main → renderer
  // ─────────────────────────────────────────────────────────────

  ipcMainProxy.handle('gateway-transcript-subscribe', async() => {
    try {
      const { getGatewayConnectionController } = await import('@pkg/agent/controllers/GatewayConnectionController');
      const windowModule = await import('@pkg/window');
      const controller = getGatewayConnectionController();

      await controller.subscribeTranscripts((event) => {
        try {
          console.log(`[Sulla] Sending gateway-transcript IPC: ${ (event as any).event_type }`);
          windowModule.send('gateway-transcript' as any, event);
        } catch (err: any) {
          console.error(`[Sulla] gateway-transcript IPC send failed: ${ err.message }`);
        }
      });

      return { ok: true };
    } catch (err: any) {
      console.error('[Sulla] gateway-transcript-subscribe failed:', err.message);

      return { ok: false, error: err.message };
    }
  });

  ipcMainProxy.handle('gateway-transcript-unsubscribe', async() => {
    try {
      const { getGatewayConnectionController } = await import('@pkg/agent/controllers/GatewayConnectionController');
      getGatewayConnectionController().unsubscribeTranscripts();

      return { ok: true };
    } catch (err: any) {
      console.error('[Sulla] gateway-transcript-unsubscribe failed:', err.message);

      return { ok: false, error: err.message };
    }
  });

  // ─────────────────────────────────────────────────────────────
  // Integration value helpers
  // ─────────────────────────────────────────────────────────────

  ipcMainProxy.handle('integration-get-value', async(_event: unknown, integrationId: string, property: string) => {
    const { getIntegrationService } = await import('@pkg/agent/services/IntegrationService');
    const service = getIntegrationService();
    const value = await service.getIntegrationValue(integrationId, property);

    return value ? { value: value.value } : null;
  });

  ipcMainProxy.handle('integration-accounts', async(_event: unknown, slug: string) => {
    try {
      const { getIntegrationService } = await import('@pkg/agent/services/IntegrationService');
      const svc = getIntegrationService();

      return await svc.getAccounts(slug);
    } catch (err) {
      console.warn('[Sulla] integration-accounts failed:', err);

      return [];
    }
  });

  // ─────────────────────────────────────────────────────────────
  // Voice event logging — persists frontend voice events to thread log files
  // ─────────────────────────────────────────────────────────────

  ipcMainProxy.on('voice-log', (_event: unknown, entry: { type: string; ts: string; threadId: string; channel: string; [key: string]: unknown }) => {
    try {
      const { getConversationLogger } = require('@pkg/agent/services/ConversationLogger');
      const logger = getConversationLogger();
      const { threadId, channel, ...eventData } = entry;

      // Ensure the log file path is resolved with the correct channel prefix
      // so voice logs land in the same file as the graph conversation
      // (e.g., sulla-desktop_thread_123.log)
      (logger).resolveFilePath(threadId, channel);

      logger.log(threadId, {
        ...eventData,
        ts: entry.ts,
      });
    } catch (err) {
      console.error('[Sulla] Voice log write failed:', err);
    }
  });

  // ─────────────────────────────────────────────────────────────
  // Integration value change relay — renderer → main process
  // ─────────────────────────────────────────────────────────────

  ipcMainProxy.on('integration-value-changed', async(_event: unknown, payload: { integration_id: string; property: string; action: string }) => {
    console.log(`[Sulla] Integration value ${ payload.action }: ${ payload.integration_id }/${ payload.property }`);

    // Notify main-process IntegrationService subscribers
    try {
      const { getIntegrationService } = await import('@pkg/agent/services/IntegrationService');
      const service = getIntegrationService();
      // Re-read the value from DB so main-process callbacks get the current data
      const value = await service.getIntegrationValue(payload.integration_id, payload.property);
      if (value) {
        // Fire the main-process onValueChange callbacks
        (service as any).notifyValueChange(value, payload.action);
      }
    } catch (err) {
      console.warn('[Sulla] Integration value relay failed:', err);
    }
  });

  // ─────────────────────────────────────────────────────────────
  // Computer Use — probe AppleScript to trigger macOS TCC dialog
  // ─────────────────────────────────────────────────────────────

  ipcMainProxy.handle('computer-use:request-permission', async(_event: unknown, appName: string) => {
    if (process.platform !== 'darwin') {
      return { ok: true, status: 'granted' as const };
    }
    try {
      const { execFile } = await import('child_process');
      // Use a meaningful probe that forces an Apple Event to the target app.
      // This triggers the macOS TCC dialog if permission hasn't been decided yet.
      const script = `tell application "${ appName }" to return name`;
      const result = await new Promise<{ ok: boolean; stderr: string }>((resolve) => {
        execFile('osascript', ['-e', script], { timeout: 15000 }, (err, _stdout, stderr) => {
          if (err) {
            resolve({ ok: false, stderr: (stderr || err.message || '').trim() });
          } else {
            resolve({ ok: true, stderr: '' });
          }
        });
      });

      if (result.ok) {
        console.log(`[ComputerUse] Permission probe succeeded for "${ appName }"`);

        return { ok: true, status: 'granted' as const };
      }

      // macOS returns "not allowed assistive access" or similar on TCC denial
      const denied = /not allowed|assistive access|not permitted|errAEEventNotPermitted/i.test(result.stderr);

      console.warn(`[ComputerUse] Permission probe for "${ appName }": ${ result.stderr }`);

      return {
        ok:     false,
        status: denied ? 'denied' as const : 'error' as const,
        error:  result.stderr,
      };
    } catch (err: any) {
      console.error(`[ComputerUse] Permission probe exception for "${ appName }":`, err);

      return { ok: false, status: 'error' as const, error: err.message };
    }
  });

  // ─────────────────────────────────────────────────────────────
  // Computer Use — batch health check for all enabled apps
  // ─────────────────────────────────────────────────────────────

  ipcMainProxy.handle('computer-use:health-check', async(_event: unknown, appNames: string[]) => {
    if (process.platform !== 'darwin') {
      return Object.fromEntries(appNames.map(n => [n, { ok: true, status: 'granted' }]));
    }
    const { execFile } = await import('child_process');
    const results: Record<string, { ok: boolean; status: string; error?: string }> = {};

    await Promise.all(appNames.map(appName => new Promise<void>((done) => {
      const script = `tell application "${ appName }" to return name`;

      execFile('osascript', ['-e', script], { timeout: 15000 }, (err, _stdout, stderr) => {
        if (!err) {
          results[appName] = { ok: true, status: 'granted' };
        } else {
          const msg = (stderr || err.message || '').trim();
          const denied = /not allowed|assistive access|not permitted|errAEEventNotPermitted/i.test(msg);

          results[appName] = { ok: false, status: denied ? 'denied' : 'error', error: msg };
        }
        done();
      });
    })));

    return results;
  });

  console.log('[Sulla] IPC event handlers initialized');

  // ─────────────────────────────────────────────────────────────
  // System sleep / wake
  // ─────────────────────────────────────────────────────────────

  const { powerMonitor, BrowserWindow } = require('electron') as typeof import('electron');

  powerMonitor.on('resume', () => {
    console.log('[Power] System resumed');

    // Re-initialize the backend graph executor so it re-subscribes its
    // message handlers after wake.
    try {
      const { getBackendGraphWebSocketService } = require('@pkg/agent/services/BackendGraphWebSocketService');
      getBackendGraphWebSocketService().reinitialize();
    } catch (err) {
      console.warn('[Power] Failed to reinitialize backend graph service:', err);
    }

    // Notify all renderer windows so frontend services can react
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        win.webContents.send('system-resumed');
      } catch (err) {
        console.warn('[Power] Failed to notify renderer window of resume:', err);
      }
    }
  });

  // Auto-connect gateway lobby listener once DB is ready.
  // All decision-making lives in GatewayConnectionController.
  (async() => {
    try {
      const { getDatabaseManager } = await import('@pkg/agent/database/DatabaseManager');
      const dbManager = getDatabaseManager();
      await dbManager.initialize(); // returns immediately if already initialized, waits otherwise

      const { getGatewayConnectionController } = await import('@pkg/agent/controllers/GatewayConnectionController');
      await getGatewayConnectionController().initialize();
    } catch (err) {
      console.warn('[Sulla] Gateway lobby auto-connect failed:', err);
    }
  })();
}
