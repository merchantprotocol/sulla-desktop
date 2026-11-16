// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash, randomUUID } from 'node:crypto';

import type { Config } from '../config.js';
import type { TransactionRunner } from '../FilesTransaction.js';
import type { SystemAreaRepository } from '../Repositories/SystemAreaRepository.js';

interface SystemAreaFolder { readonly path:string; readonly description?:string }
interface SystemAreaDefinition { readonly key:string; readonly name:string; readonly explorerPath:string; readonly folders:readonly (string | SystemAreaFolder)[] }

/**
 * Creates the system areas (the owner's Files home and the internal Logs store) and their
 * standard folders. Safe to run on every start: existing rows are reused and only missing
 * folders or descriptions are filled in.
 */
export class SystemAreaProvisioner {
  // 'logs' is the internal audit store (FileAuditWriter appends audit/files and audit/vault).
  // It is not mounted, mirrored or shown in the File Manager.
  static readonly areas:readonly SystemAreaDefinition[] = Object.freeze([
    { key: 'logs', name: 'Logs', explorerPath: 'Logs', folders: ['audit/files', 'audit/vault'] },
    { key: 'home', name: 'Files', explorerPath: '', folders: [
      { path: 'Use Cases/skills' }, { path: 'Use Cases/workflows' }, { path: 'Use Cases/agents' },
      { path: 'Use Cases/functions' }, { path: 'Use Cases/recipes' }, { path: 'Projects' }, { path: 'Identity' },
      { path: 'Memory', description: 'Durable agent memory. Memory files are live as soon as they are written (no publish step). Record durable facts as observations too.' },
      { path: 'Memory/claude-code', description: 'Claude Code project memory files.' },
      { path: 'Memory/codex', description: 'Codex CLI memory database snapshot.' },
      { path: 'Memory/sulla', description: 'Memories written by Sulla agents and services.' },
    ] },
  ]);

  constructor(private readonly transactions:TransactionRunner, private readonly repository:SystemAreaRepository) {}

  /** The deterministic id of a user's Files root collection. */
  static collectionIdFor(userId:string, rootId = 'default'):string {
    const identity = rootId === 'default' ? `sulla-files:v1:${ userId }` : `sulla-files:root:v1:${ userId }:${ rootId }`;
    const value = createHash('sha256').update(identity).digest('hex').slice(0, 32).split(''); value[12] = '4'; value[16] = '8';
    return `${ value.slice(0, 8).join('') }-${ value.slice(8, 12).join('') }-${ value.slice(12, 16).join('') }-${ value.slice(16, 20).join('') }-${ value.slice(20).join('') }`;
  }

  /** Read-only system storage is structural: no caller grants can override it. */
  static assertWritable(area:unknown):void {
    if (area === 'logs') {
      throw Object.assign(new Error('System area is read-only'), { status: 403, code: 'EROFS' });
    }
  }

  async ensure(config:Config):Promise<void> {
    const keyring = config.keyring;
    if (!keyring?.unlocked) throw new Error('Files keyring must be unlocked before system areas are initialized');
    await this.transactions.run('system-areas', async client => {
      for (const area of SystemAreaProvisioner.areas) {
        await this.repository.lockArea(client, area.key);
        let collection = area.key === 'home'
          ? await this.repository.findHome(client, config.userId)
          : await this.repository.findBySystemArea(client, area.key);
        if (!collection) {
          const id = area.key === 'home' ? SystemAreaProvisioner.collectionIdFor(config.userId) : randomUUID();
          collection = await this.repository.insertCollection(client, {
            id, orgId: config.orgId ?? null, ownerUserId: config.userId, name: area.name,
            systemArea: area.key === 'home' ? null : area.key, explorerPath: area.explorerPath,
          });
          const wrapped = await keyring.create(id, client);
          await this.repository.setKeys(client, id, wrapped.data, wrapped.dedup);
        }
        for (const folderEntry of area.folders) {
          const folder = typeof folderEntry === 'string' ? folderEntry : folderEntry.path;
          const parts = folder.split('/');
          for (let index = 1; index <= parts.length; index++) {
            const path = parts.slice(0, index).join('/');
            const description = index === parts.length && typeof folderEntry !== 'string' ? folderEntry.description ?? null : null;
            await this.repository.upsertFolder(client, collection.id, path, description);
          }
        }
      }
    });
  }
}
