// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { isLegacyInternalPath } from './legacyPreflight.js';
import { isProtectedPath } from './protectedFiles.js';
import { TrackedPathFilter } from './TrackedPathFilter.js';

import type { Config, FileRootConfig } from './config.js';
import type { WatchedFolderRepository } from './Repositories/WatchedFolderRepository.js';
import type { ScanProgress } from './ScanProgress.js';
import type { WatchedFileIngestor } from './WatchedFileIngestor.js';

interface DiskScan { paths: string[]; complete: boolean; errors: string[] }

/**
 * Reconciles native tracked roots with Files: walks the folder, ingests changed files, detects
 * renames by content and moves vanished files to Trash. Deletion is suspended when the folder looks
 * unavailable (empty, or >=100 files and >=80% missing) so an unmounted disk never trashes the index.
 */
export class NativeRootScanner {
  constructor(
    private readonly config:Config,
    private readonly roots:FileRootConfig[],
    private readonly rootCollections:Map<string, string>,
    private readonly repository:WatchedFolderRepository,
    private readonly ingestor:WatchedFileIngestor,
    private readonly progress:ScanProgress,
  ) {}

  async ignores(root:FileRootConfig):Promise<string[]> { try { return [...TrackedPathFilter.defaultIgnores, ...root.exclusions, ...(await readFile(join(root.path, '.sullaignore'), 'utf8')).split(/\r?\n/)] } catch { return [...TrackedPathFilter.defaultIgnores, ...root.exclusions] } }

  private async diskFiles(configuredRoot:FileRootConfig, current = configuredRoot.path, prefix = '', patterns?:string[]):Promise<DiskScan> {
    const ignores = patterns ?? await this.ignores(configuredRoot); const output:DiskScan = { paths: [], complete: true, errors: [] };
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }) } catch (error:any) {
      return { paths: [], complete: false, errors: [`Could not read ${ prefix || 'the tracked folder' }: ${ error?.code ?? 'filesystem error' }`] };
    }
    for (const entry of entries) {
      const rel = prefix ? `${ prefix }/${ entry.name }` : entry.name;
      if (isProtectedPath(rel) || TrackedPathFilter.isSensitive(rel) || (configuredRoot.primary && isLegacyInternalPath(rel, this.config.legacyPreflight)) || TrackedPathFilter.matchIgnore(rel, ignores)) continue;
      if (entry.isDirectory()) {
        const nested = await this.diskFiles(configuredRoot, join(current, entry.name), rel, ignores);
        output.paths.push(...nested.paths); output.complete &&= nested.complete; output.errors.push(...nested.errors);
      } else if (entry.isFile() && rel !== '.sullaignore') output.paths.push(rel);
    }
    return output;
  }

  /** Scan every unpaused root; one root's failure is recorded on that root and does not stop the rest. */
  async scanAll():Promise<void> {
    const pendingOperation = await this.repository.pendingPathOperation();
    if (pendingOperation) throw new Error(`Files path operation ${ pendingOperation } must be reconciled before watcher scanning`);
    for (const root of this.roots) {
      if (root.paused) continue;
      try { await this.scanRoot(root) } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.repository.markRootFailed(root.id, message);
        console.error(`[SullaFiles] root ${ root.id } scan failed`, error);
      }
    }
  }

  async scanRoot(root:FileRootConfig):Promise<void> {
    const collectionId = this.rootCollections.get(root.id)!;
    await this.repository.markRootScanning(root.id);
    const patterns = await this.ignores(root); const scanned = await this.diskFiles(root, root.path, '', patterns); const diskSet = new Set(scanned.paths);
    const states = (await this.repository.localStates(root.id)).filter(row => !root.primary || !isLegacyInternalPath(row.path, this.config.legacyPreflight));
    const reconciledStates = states.filter(row => !isProtectedPath(row.path) && !TrackedPathFilter.isSensitive(row.path) && !TrackedPathFilter.matchIgnore(row.path, patterns));
    const missingRows = reconciledStates.filter(row => !diskSet.has(row.path));
    if (scanned.complete && reconciledStates.length > 0 && (scanned.paths.length === 0 || (missingRows.length >= 100 && missingRows.length / reconciledStates.length >= 0.8))) {
      throw new Error('Folder availability changed unexpectedly; deletion reconciliation was suspended to protect indexed files');
    }
    const missing = new Map(missingRows.map(row => [row.content_hash, row]));
    const diskInfo = new Map<string, { size:number; mtimeMs:number }>();
    for (const filePath of scanned.paths) {
      try { const info = await stat(TrackedPathFilter.inside(root, filePath)); if (info.isFile()) diskInfo.set(filePath, { size: info.size, mtimeMs: info.mtimeMs }) } catch (error:any) { scanned.complete = false; scanned.errors.push(`Could not inspect ${ filePath }: ${ error?.code ?? 'filesystem error' }`) }
    }
    const disk = [...diskInfo.keys()];
    const changedPaths = disk.filter(filePath => { const current = states.find(row => row.path === filePath); const info = diskInfo.get(filePath)!; return (!current || Number(current.size) !== info.size || Number(current.mtime_ms) !== Math.trunc(info.mtimeMs)) });
    this.progress.begin(changedPaths.length + missing.size, changedPaths.reduce((sum, filePath) => sum + diskInfo.get(filePath)!.size, 0));
    await this.repository.setRootPending(root.id, this.progress.pendingFiles);
    let changed = 0;
    for (const filePath of disk) {
      const info = diskInfo.get(filePath)!; const old = states.find(row => row.path === filePath);
      if (old && Number(old.size) === info.size && Number(old.mtime_ms) === Math.trunc(info.mtimeMs)) continue;
      try { if (await this.ingestor.ingest(root, collectionId, filePath, info.mtimeMs, old, missing)) changed++ } catch (error:any) { scanned.errors.push(`Could not import ${ filePath }: ${ error?.code ?? error?.message ?? 'filesystem error' }`) }
      this.progress.advance(info.size);
    }
    const currentStates = await this.repository.rootStates(root.id);
    if (scanned.complete) for (const row of reconciledStates) if (!diskSet.has(row.path) && !currentStates.some(current => current.file_id === row.file_id && current.path !== row.path)) { await this.ingestor.softDelete(row); changed++ }
    this.progress.finishScan(); await this.repository.markRuntimeScanned();
    const scanError = scanned.errors.length ? scanned.errors.slice(0, 5).join('; ').slice(0, 2000) : null;
    await this.repository.finishRootScan(root.id, scanError);
    if (changed) console.log(`[SullaFiles] recorded ${ changed } watched folder change(s) for root ${ root.id }`);
  }
}
