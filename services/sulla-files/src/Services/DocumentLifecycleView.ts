// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { LifecycleHttpError } from './LifecycleHttpError.js';

export interface VersionPageRequest { limit:number; cursor?:{ createdAt:string; id:string } }

/** Shapes file rows and version pages into the lifecycle JSON the clients read. Pure; no I/O. */
export class DocumentLifecycleView {
  iso(value:any):string | undefined { return value?.toISOString?.() ?? value ?? undefined }

  fields(file:any) {
    const iso = (value:any) => this.iso(value);
    const { search_text: _st, search_vector: _sv, ...rest } = file;
    return {
      ...rest,
      publication_state: 'published',
      versioning: { enabled: file.versioning_enabled, majorMinor: file.major_minor_enabled, requireApproval: file.require_approval, requireCheckout: file.require_checkout },
      checkout: file.checked_out_by_user_id ? { userId: file.checked_out_by_user_id, deviceId: file.checked_out_by_device_id, at: iso(file.checked_out_at) } : null,
      retention: { mode: file.retention_mode, retainUntil: iso(file.retain_until), eventType: file.retention_event_type, eventOccurredAt: iso(file.retention_event_at), durationDays: file.retention_duration_days },
      record: { status: file.record_lock_type, lockedAt: iso(file.record_locked_at), lockedBy: file.record_locked_by },
      disposal: { status: file.disposal_status, reviewAt: iso(file.disposal_review_at), extendedUntil: iso(file.disposal_extended_until) },
    };
  }

  capabilities(_role:string | undefined, _draftVisible:boolean) {
    return {canEdit:true,canManage:true,canViewDraft:true,canPublish:true};
  }

  /** limit clamps to 1..100 (default 50); the cursor is base64url JSON {createdAt,id} or a 400. */
  parseVersionPage(limitParam:unknown, cursorParam:unknown):VersionPageRequest {
    const requested = Number(limitParam ?? 50);
    const limit = Number.isInteger(requested) ? Math.max(1, Math.min(100, requested)) : 50;
    let cursor:{createdAt:string;id:string}|undefined;
    if (cursorParam) {
      try { const parsed=JSON.parse(Buffer.from(String(cursorParam),'base64url').toString('utf8')); if(typeof parsed.createdAt!=='string'||typeof parsed.id!=='string') throw new Error('invalid cursor'); cursor=parsed; }
      catch { throw LifecycleHttpError.of(400,'invalid versions cursor'); }
    }
    return { limit, cursor };
  }

  /** `rows` were fetched with limit+1, so an extra row means there is a next page. */
  versionsPage(file:any, rows:any[], limit:number) {
    const iso = (value:any) => this.iso(value);
    const hasMore=rows.length>limit; const page=rows.slice(0,limit); const last=page.at(-1);
    return {
      fileId:file.id,draftVersionId:file.draft_version_id,publishedVersionId:file.published_version_id,
      recordLockType:file.record_lock_type,retentionMode:file.retention_mode,retainUntil:iso(file.retain_until),disposalStatus:file.disposal_status,
      versions:page.map(row => ({id:row.id,major:row.major_version,minor:row.minor_version,kind:row.version_kind,
        publication_status:row.publication_status,created_by:{type:row.created_by_type,id:row.created_by_id},created_at:iso(row.created_at),comment:row.version_comment,size:Number(row.size)})),
      nextCursor:hasMore&&last?Buffer.from(JSON.stringify({createdAt:new Date(last.created_at).toISOString(),id:last.id})).toString('base64url'):null,
    };
  }
}
