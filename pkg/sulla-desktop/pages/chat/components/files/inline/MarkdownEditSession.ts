// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export type MarkdownSaveOutcome =
  | { requestId: number; status: 'saved' | 'merged'; content: string; versionToken: string }
  | { requestId: number; status: 'conflict' | 'error'; message?: string; currentVersionToken?: string };

export interface MarkdownSourceState {
  content: string;
  versionToken?: string;
  authorized: boolean;
  complete: boolean;
}

export interface MarkdownSaveRequest {
  requestId: number;
  content: string;
  baseVersionId: string;
}

export interface MarkdownEditSnapshot {
  editing: boolean;
  draft: string;
  canEdit: boolean;
  canSave: boolean;
  externalChange: boolean;
  saveStatus: 'idle' | 'saving' | 'saved' | 'merged' | 'conflict' | 'error';
  message: string;
}

/** Keeps an authorized complete Markdown draft tied to the exact version it opened from. */
export class MarkdownEditSession {
  private source: MarkdownSourceState;
  private editing = false;
  private draft = '';
  private originalContent = '';
  private originalVersionToken = '';
  private externalChange = false;
  private pendingRequestId: number | null = null;
  private nextRequestId = 1;
  private saveStatus: MarkdownEditSnapshot['saveStatus'] = 'idle';
  private message = '';

  constructor(source: MarkdownSourceState) {
    this.source = { ...source };
  }

  get canEdit(): boolean {
    return this.source.authorized && this.source.complete && Boolean(this.source.versionToken?.trim());
  }

  snapshot(): MarkdownEditSnapshot {
    return {
      editing: this.editing,
      draft: this.draft,
      canEdit: this.canEdit,
      canSave: this.editing && !this.externalChange && this.pendingRequestId === null && this.draft !== this.originalContent,
      externalChange: this.externalChange,
      saveStatus: this.saveStatus,
      message: this.message,
    };
  }

  beginEdit(): boolean {
    if (!this.canEdit || this.editing) return false;
    this.editing = true;
    this.draft = this.source.content;
    this.originalContent = this.source.content;
    this.originalVersionToken = this.source.versionToken!.trim();
    this.externalChange = false;
    this.pendingRequestId = null;
    this.saveStatus = 'idle';
    this.message = '';
    return true;
  }

  setDraft(content: string): void {
    if (this.editing && this.pendingRequestId === null) this.draft = content;
  }

  updateSource(source: MarkdownSourceState): void {
    this.source = { ...source };
    if (!this.editing) return;
    if (!source.authorized || !source.complete || source.content !== this.originalContent || source.versionToken !== this.originalVersionToken) {
      this.externalChange = true;
      this.message = 'The file changed while this draft was open. Your draft is preserved; saving is disabled to protect the newer version.';
    }
  }

  requestSave(): MarkdownSaveRequest | null {
    const current = this.snapshot();
    if (!current.canSave || !this.originalVersionToken) return null;
    const requestId = this.nextRequestId++;
    this.pendingRequestId = requestId;
    this.saveStatus = 'saving';
    this.message = '';
    return { requestId, content: this.draft, baseVersionId: this.originalVersionToken };
  }

  resolveSave(outcome: MarkdownSaveOutcome): boolean {
    if (this.pendingRequestId !== outcome.requestId) return false;
    this.pendingRequestId = null;

    if (outcome.status === 'saved' || outcome.status === 'merged') {
      this.source = { ...this.source, content: outcome.content, versionToken: outcome.versionToken };
      this.originalContent = outcome.content;
      this.originalVersionToken = outcome.versionToken;
      this.draft = outcome.content;
      this.editing = false;
      this.externalChange = false;
      this.saveStatus = outcome.status;
      this.message = '';
      return true;
    }

    this.saveStatus = outcome.status;
    this.externalChange = outcome.status === 'conflict';
    this.message = ('message' in outcome ? outcome.message : undefined) ?? (outcome.status === 'conflict'
      ? 'The file changed before this draft could be saved. Your draft is preserved.'
      : 'The draft could not be saved. Your changes are preserved.');
    return true;
  }

  discardDraft(): void {
    this.editing = false;
    this.draft = '';
    this.originalContent = '';
    this.originalVersionToken = '';
    this.externalChange = false;
    this.pendingRequestId = null;
    this.saveStatus = 'idle';
    this.message = '';
  }
}
