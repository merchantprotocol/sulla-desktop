// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomUUID } from 'node:crypto';

import type express from 'express';

import type { BackupDestinationRequestParser } from '../backup/BackupDestinationRequestParser.js';
import type { BackupRuntimeRequests } from '../backup/runtime.js';
import type { PersonalBackupScheduler } from '../backup/scheduler.js';
import type { Config } from '../config.js';
import type { TransactionRunner } from '../FilesTransaction.js';
import { HttpError } from '../Http/HttpError.js';
import type { LocalBackupDestinationRepository } from '../Repositories/LocalBackupDestinationRepository.js';

/** Desktop-only personal backup administration: destinations, on-demand runs and Desktop mount handshakes. */
export class LocalBackupRoutes {
  constructor(
    private readonly config:Config,
    private readonly destinations:LocalBackupDestinationRepository,
    private readonly requests:BackupDestinationRequestParser,
    private readonly runtime:BackupRuntimeRequests,
    private readonly scheduler:PersonalBackupScheduler,
    private readonly transactions:TransactionRunner,
  ) {}

  register(app:express.Express):void {
    app.use('/v1/local/backups', (_request, response, next) => this.config.mode === 'desktop' ? next() : response.sendStatus(404));
    app.get('/v1/local/backups', async(_request, response, next) => { try { response.json(await this.list()) } catch (error) { next(error) } });
    app.post('/v1/local/backups/runtime/:id', async(request, response) => {
      if (!this.runtime.complete(request.params.id, request.body?.ok === true)) return response.sendStatus(404);
      response.sendStatus(204);
    });
    app.post('/v1/local/backups/destinations', async(request, response, next) => { try {
      const { kind, label, destination } = this.requests.parse(request.body);
      response.status(201).json(await this.destinations.create(randomUUID(), kind, label, destination));
    } catch (error) { next(error) } });
    app.delete('/v1/local/backups/destinations/:id', async(request, response, next) => { try {
      await this.remove(request.params.id);
      response.sendStatus(204);
    } catch (error) { next(error) } });
    app.post('/v1/local/backups/:id/run', async(request, response, next) => { try {
      const destination = await this.destinations.findEnabled(request.params.id); if (!destination) throw new HttpError(404, 'Backup destination not found');
      try { response.status(202).json({ runId: await this.scheduler.enqueue(destination.id, destination.config, 'hourly') }) } catch { throw new HttpError(409, 'Backup is already running or the service is unavailable') }
    } catch (error) { next(error) } });
  }

  private async list() {
    const destinations = await this.destinations.list();
    const status = await this.destinations.latestRuns();
    return { destinations: destinations.map(item => ({ ...item, status: status.find(run => run.destination_id === item.id) })), runtimeRequests: this.runtime.list(), retention: { hourly: 24, daily: 30, weekly: 12 } };
  }

  /** Holds the destination's backup lock so a running backup is never orphaned; a NAS share is unmounted first. */
  private async remove(id:string):Promise<void> {
    await this.transactions.run('backup.destination.remove', async client => {
      if (!await this.destinations.tryLockForRemoval(client, id)) throw new HttpError(409, 'Wait for the running backup before removing this destination');
      const row = await this.destinations.findForUpdate(client, id);
      if (!row) throw new HttpError(404, 'Backup destination not found');
      if (row.kind === 'nas') await this.runtime.prepare(row.id, 'unmount');
      await this.destinations.remove(client, row.id);
    });
  }
}
