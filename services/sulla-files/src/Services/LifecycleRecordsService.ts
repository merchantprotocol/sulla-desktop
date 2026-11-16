// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { LifecycleHttpError } from './LifecycleHttpError.js';

import type { FilesIdentity } from '../auth.js';
import type { TransactionRunner } from '../FilesTransaction.js';
import type { DocumentLifecycleRepository } from '../Repositories/DocumentLifecycleRepository.js';
import type pg from 'pg';

const DAY_MS = 86_400_000;

export interface RetentionInput { mode:string; retainUntil:Date | null; eventAt:Date | null; eventType?:unknown; days:number | null }

/**
 * Versioning settings, checkout, retention, record locks, disposal review and cross-device
 * lifecycle-state sync. Every change bumps lifecycle_generation and journals the file.
 */
export class LifecycleRecordsService {
  constructor(
    private readonly lifecycle:DocumentLifecycleRepository,
    private readonly transactions:TransactionRunner,
  ) {}

  private async lockedFile(client:pg.PoolClient, id:string):Promise<any> {
    const row = await this.lifecycle.lockFile(client, id);
    if (!row) throw LifecycleHttpError.of(404, 'file not found');
    return row;
  }

  /** The end of a retention period, or null when it has none. */
  private retentionEnd(mode:unknown, retainUntil:unknown, eventAt:unknown, days:unknown):Date | unknown | null {
    return mode === 'retain-until' ? retainUntil : mode === 'event' && eventAt && days != null ? new Date(new Date(eventAt as string).valueOf() + Number(days) * DAY_MS) : null;
  }

  async updateSettings(fileId:string, body:Record<string, unknown> | undefined):Promise<any> {
    const allowed = ['enabled','majorMinor','requireApproval','requireCheckout'];
    if (!Object.keys(body ?? {}).every(key => allowed.includes(key))) throw LifecycleHttpError.of(400, 'unsupported lifecycle setting');
    return this.transactions.run('lifecycle-settings', async client => {
      const file = await this.lockedFile(client, fileId);
      if (file.record_lock_type === 'policy') throw LifecycleHttpError.of(423, 'policy record lifecycle settings cannot be changed');
      const values = [body!.enabled, body!.majorMinor, body!.requireApproval, body!.requireCheckout]
        .map(value => value === undefined ? null : Boolean(value));
      const row = await this.lifecycle.updateSettings(client, file.id, values[0], values[1], values[2], values[3]);
      await this.lifecycle.journalFile(client, row); return row;
    });
  }

  checkout(fileId:string, actor:FilesIdentity):Promise<any> {
    return this.transactions.run('lifecycle-checkout', async client => {
      const file = await this.lockedFile(client, fileId);
      if (file.record_lock_type !== 'none') throw LifecycleHttpError.of(423, 'record is locked');
      if (file.checked_out_by_user_id && (file.checked_out_by_user_id !== actor.userId || file.checked_out_by_device_id !== (actor.deviceId || 'server-web'))) throw LifecycleHttpError.of(409, 'file is checked out by another editor');
      const result = await this.lifecycle.checkout(client, file.id, actor.userId, actor.deviceId || 'server-web');
      await this.lifecycle.journalFile(client, result); return result;
    });
  }

  releaseCheckout(fileId:string, actor:FilesIdentity, force:boolean):Promise<any> {
    return this.transactions.run('lifecycle-checkout-release', async client => {
      const file = await this.lockedFile(client, fileId);
      if (file.checked_out_by_user_id !== actor.userId && !force) throw LifecycleHttpError.of(409, 'only the checkout owner can discard checkout');
      const result = await this.lifecycle.releaseCheckout(client, file.id);
      await this.lifecycle.journalFile(client, result); return result;
    });
  }

  /** Validates a retention request body before any lock is taken. */
  parseRetention(body:Record<string, any> | undefined):RetentionInput {
    const mode = body?.mode;
    if (!['none','retain-until','event'].includes(mode)) throw LifecycleHttpError.of(400, 'retention mode must be none, retain-until, or event');
    const retainUntil = body?.retainUntil == null ? null : new Date(body.retainUntil);
    const eventAt = body?.eventOccurredAt == null ? null : new Date(body.eventOccurredAt);
    const days = body?.durationDays == null ? null : Number(body.durationDays);
    if (mode === 'retain-until' && (!retainUntil || Number.isNaN(retainUntil.valueOf()))) throw LifecycleHttpError.of(400, 'valid retainUntil is required');
    if (mode === 'event' && (typeof body?.eventType !== 'string' || !body.eventType.trim() || days === null || !Number.isInteger(days) || days < 0)) throw LifecycleHttpError.of(400, 'eventType and non-negative durationDays are required');
    return { mode, retainUntil, eventAt, eventType: body?.eventType, days };
  }

  updateRetention(fileId:string, input:RetentionInput):Promise<any> {
    const { mode, retainUntil, eventAt, days } = input;
    return this.transactions.run('lifecycle-retention', async client => {
      const file = await this.lockedFile(client, fileId);
      if (file.record_lock_type === 'policy') {
        const oldEnd = this.retentionEnd(file.retention_mode, file.retain_until, file.retention_event_at, file.retention_duration_days);
        const newEnd = mode === 'retain-until' ? retainUntil : mode === 'event' && eventAt && days != null ? new Date(eventAt.valueOf() + days * DAY_MS) : null;
        if (!oldEnd || !newEnd || newEnd < new Date(oldEnd as string)) throw LifecycleHttpError.of(423, 'policy record retention cannot be shortened or cleared');
      }
      const updated = await this.lifecycle.updateRetention(client, file.id, mode, mode === 'retain-until' ? retainUntil : null, mode === 'event' ? String(input.eventType).trim() : null, mode === 'event' ? eventAt : null, mode === 'event' ? days : null);
      await this.lifecycle.journalFile(client, updated); return updated;
    });
  }

  async lockRecord(fileId:string, actor:FilesIdentity, kind:string):Promise<any> {
    if (kind !== 'ordinary' && kind !== 'policy') throw LifecycleHttpError.of(400, 'record lock kind must be ordinary or policy');
    return this.transactions.run('lifecycle-record-lock', async client => {
      const file = await this.lockedFile(client, fileId); if (file.record_lock_type === 'policy' && kind !== 'policy') throw LifecycleHttpError.of(423, 'policy records cannot be downgraded');
      const updated = await this.lifecycle.setRecordLock(client, file.id, kind, actor.userId);
      await this.lifecycle.journalFile(client, updated); return updated;
    });
  }

  unlockRecord(fileId:string):Promise<any> {
    return this.transactions.run('lifecycle-record-unlock', async client => {
      const file = await this.lockedFile(client, fileId); if (file.record_lock_type === 'policy') throw LifecycleHttpError.of(423, 'policy records cannot be unlocked through the ordinary records API');
      const updated = await this.lifecycle.clearRecordLock(client, file.id);
      await this.lifecycle.journalFile(client, updated); return updated;
    });
  }

  async reviewDisposal(fileId:string, decision:unknown, extendedUntil:unknown):Promise<any> {
    if (!['approve','reject','extend'].includes(decision as string)) throw LifecycleHttpError.of(400, 'disposal decision must be approve, reject, or extend');
    return this.transactions.run('lifecycle-disposal-review', async client => {
      const file = await this.lockedFile(client, fileId);
      const active = await this.lifecycle.retentionActive(client, file.id);
      if (decision === 'approve' && active) throw LifecycleHttpError.of(409, 'active retention or record lock prevents disposal approval');
      const extension = decision === 'extend' ? new Date(extendedUntil as string) : null;
      if (decision === 'extend' && (!extension || Number.isNaN(extension.valueOf()) || extension <= new Date())) throw LifecycleHttpError.of(400, 'future extendedUntil is required');
      const updated = await this.lifecycle.reviewDisposal(client, file.id, decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'pending', extension);
      await this.lifecycle.journalFile(client, updated); return updated;
    });
  }

  /** Applies another device's lifecycle state when its generation is newer and policy allows it. */
  async applyState(fileId:string, incoming:any):Promise<{ applied:boolean; file:any }> {
    if (!incoming || incoming.id !== fileId || !Number.isInteger(Number(incoming.lifecycle_generation))) throw LifecycleHttpError.of(400, 'valid lifecycle state is required');
    if (!['none','retain-until','event'].includes(incoming.retention_mode) || !['none','ordinary','policy'].includes(incoming.record_lock_type) || !['none','pending','approved','rejected'].includes(incoming.disposal_status)) throw LifecycleHttpError.of(400, 'invalid lifecycle state');
    return this.transactions.run('lifecycle-state-sync', async client => {
      const current = await this.lockedFile(client, fileId); const generation = Number(incoming.lifecycle_generation);
      if (generation <= Number(current.lifecycle_generation)) return { applied: false, file: current };
      if (current.record_lock_type === 'policy' && incoming.record_lock_type !== 'policy') return { applied: false, file: current };
      const oldEnd = this.retentionEnd(current.retention_mode, current.retain_until, current.retention_event_at, current.retention_duration_days);
      const nextEnd = this.retentionEnd(incoming.retention_mode, incoming.retain_until, incoming.retention_event_at, incoming.retention_duration_days);
      if (current.record_lock_type === 'policy' && (!oldEnd || !nextEnd || new Date(nextEnd as string) < new Date(oldEnd as string))) return { applied: false, file: current };
      const updated = await this.lifecycle.applyLifecycleState(client,
        [current.id, Boolean(incoming.versioning_enabled), Boolean(incoming.major_minor_enabled), Boolean(incoming.require_approval), Boolean(incoming.require_checkout),
          incoming.checked_out_by_user_id ?? null, incoming.checked_out_by_device_id ?? null, incoming.checked_out_at ?? null, incoming.retention_mode,
          incoming.retain_until ?? null, incoming.retention_event_type ?? null, incoming.retention_event_at ?? null, incoming.retention_duration_days ?? null,
          incoming.record_lock_type, incoming.record_locked_at ?? null, incoming.record_locked_by ?? null, incoming.disposal_status,
          incoming.disposal_review_at ?? null, incoming.disposal_extended_until ?? null, generation]);
      await this.lifecycle.journalFile(client, updated); return { applied: true, file: updated };
    });
  }
}
