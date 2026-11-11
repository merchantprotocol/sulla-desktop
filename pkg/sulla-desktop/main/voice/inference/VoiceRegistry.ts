// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface VoiceRecord {
  id: string; label: string; name?: string; centroid: number[]; turns: number;
  holdToTalkTurns: number; firstHeard: number; lastHeard: number; isOwner: boolean;
}
interface RegistryData { voices: VoiceRecord[]; nextId: number; holdToTalkTotal: number; enabled: boolean; }

/** Local-only durable voice identities. Persists centroids, never audio. */
export class VoiceRegistry {
  private readonly file: string;
  private data: RegistryData = { voices: [], nextId: 1, holdToTalkTotal: 0, enabled: true };
  private loaded: Promise<void>;
  constructor(userDataPath: string, private readonly now: () => number = Date.now) {
    this.file = join(userDataPath, 'voice-registry.json');
    this.loaded = this.read();
  }
  private async read(): Promise<void> {
    try { this.data = { ...this.data, ...(JSON.parse(await readFile(this.file, 'utf8')) as Partial<RegistryData>) }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  private async persist(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.part`;
    await writeFile(temp, JSON.stringify(this.data), { mode: 0o600 });
    await rename(temp, this.file);
    await chmod(this.file, 0o600);
  }
  private norm(v: readonly number[]): number[] {
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    if (!Number.isFinite(n) || n === 0) throw new Error('Invalid voice embedding');
    return v.map(x => x / n);
  }
  async assign(raw: readonly number[], holdToTalk: boolean): Promise<{ voice: VoiceRecord; score: number; isNew: boolean }> {
    await this.loaded;
    const embedding = this.norm(raw); let best: VoiceRecord | undefined; let score = -1;
    for (const v of this.data.voices) {
      if (v.centroid.length !== embedding.length) continue;
      const value = embedding.reduce((s, x, i) => s + x * v.centroid[i], 0);
      if (value > score) { score = value; best = v; }
    }
    const timestamp = this.now(); let isNew = false;
    if (!best || score < 0.70) {
      if (this.data.voices.length >= 50) {
        const candidate = this.data.voices.filter(v => !v.isOwner).sort((a, b) => a.lastHeard - b.lastHeard)[0];
        if (!candidate) throw new Error('Voice registry full with no evictable voice');
        this.data.voices = this.data.voices.filter(v => v !== candidate);
      }
      const id = `voice-${this.data.nextId++}`;
      best = { id, label: `Voice ${this.data.nextId - 1}`, centroid: embedding, turns: 0, holdToTalkTurns: 0, firstHeard: timestamp, lastHeard: timestamp, isOwner: false };
      this.data.voices.push(best); score = 1; isNew = true;
    } else {
      const mean = best.centroid.map((x, i) => (x * best!.turns + embedding[i]) / (best!.turns + 1));
      best.centroid = this.norm(mean);
    }
    best.turns++; best.lastHeard = timestamp;
    if (holdToTalk) { best.holdToTalkTurns++; this.data.holdToTalkTotal++; }
    const owner = this.data.voices.filter(v => v.holdToTalkTurns >= 3 && v.holdToTalkTurns / Math.max(1, this.data.holdToTalkTotal) >= 0.6).sort((a, b) => b.holdToTalkTurns - a.holdToTalkTurns)[0];
    for (const v of this.data.voices) v.isOwner = v === owner;
    await this.persist();
    return { voice: { ...best, centroid: [...best.centroid] }, score, isNew };
  }
  async list(): Promise<VoiceRecord[]> { await this.loaded; return this.data.voices.map(v => ({ ...v, centroid: [...v.centroid] })); }
  async forget(id: string): Promise<void> { await this.loaded; this.data.voices = this.data.voices.filter(v => v.id !== id); await this.persist(); }
  async forgetAll(): Promise<void> { await this.loaded; this.data.voices = []; await this.persist(); }
  async setName(id: string, name: string): Promise<void> { await this.loaded; const v = this.data.voices.find(x => x.id === id); if (!v) throw new Error('Voice not found'); v.name = name; await this.persist(); }
  async setEnabled(enabled: boolean): Promise<void> { await this.loaded; this.data.enabled = enabled; await this.persist(); }
  async isEnabled(): Promise<boolean> { await this.loaded; return this.data.enabled; }
}
