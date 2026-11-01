// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'node:fs';
import path from 'node:path';

export type RemoteSupportStatus = 'idle' | 'waiting' | 'approval' | 'connected' | 'ended';
export interface SupportAttachment { name: string; path: string; size: number }
export interface SupportMessage { id: string; createdAt: string; body: string; attachments: SupportAttachment[] }
export interface SupportTicket extends SupportMessage { subject: string; replies: SupportMessage[] }
export interface SupportState {
  version: 1;
  logging: { sources: Record<string, boolean>; autoEnabledUntil?: string; lastErrorAt?: string };
  feedback: SupportMessage[];
  tickets: SupportTicket[];
  remote: { status: RemoteSupportStatus; requestedAt?: string; offeredAt?: string; offeredBy?: string; approvedAt?: string; endedAt?: string };
}

const DEFAULT_SOURCES = { desktop: true, runtime: true, containers: true, ai: true };
export const SUPPORT_STATE_FILE = 'support-state.json';

function initialState(): SupportState {
  return { version: 1, logging: { sources: { ...DEFAULT_SOURCES } }, feedback: [], tickets: [], remote: { status: 'idle' } };
}

export class SupportStateStore {
  constructor(private readonly userData: string) {}
  get filePath() { return path.join(this.userData, SUPPORT_STATE_FILE) }

  read(): SupportState {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<SupportState>;
      return {
        ...initialState(), ...parsed,
        logging: { ...initialState().logging, ...parsed.logging, sources: { ...DEFAULT_SOURCES, ...parsed.logging?.sources } },
        remote: { ...initialState().remote, ...parsed.remote },
        feedback: Array.isArray(parsed.feedback) ? parsed.feedback : [],
        tickets: Array.isArray(parsed.tickets) ? parsed.tickets : [],
      };
    } catch { return initialState() }
  }

  update(mutator: (state: SupportState) => void): SupportState {
    const state = this.read();
    mutator(state);
    fs.mkdirSync(this.userData, { recursive: true });
    const temporary = `${ this.filePath }.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
    return state;
  }

  noteError(now = new Date()): SupportState {
    return this.update((state) => {
      state.logging.lastErrorAt = now.toISOString();
      state.logging.autoEnabledUntil = new Date(now.getTime() + 24 * 60 * 60 * 1_000).toISOString();
      for (const source of Object.keys(DEFAULT_SOURCES)) { state.logging.sources[source] = true }
    });
  }

  /** Records an authenticated offer received by the relay. This does not grant access. */
  noteRemoteOffer(offeredBy: string, now = new Date()): SupportState {
    return this.update((state) => {
      if (state.remote.status !== 'waiting') { return }
      state.remote.status = 'approval';
      state.remote.offeredAt = now.toISOString();
      state.remote.offeredBy = offeredBy.slice(0, 120);
    });
  }
}
