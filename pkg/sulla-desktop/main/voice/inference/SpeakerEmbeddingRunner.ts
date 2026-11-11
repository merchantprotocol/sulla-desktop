// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { utilityProcess } from 'electron';

interface Child {
  postMessage(message: { id: number; modelPath: string; audio: Float32Array; sampleRate: number; appRoot: string }): void;
  on(event: 'message', callback: (message: { id: number; ok: boolean; embedding?: number[]; error?: string }) => void): void;
  on(event: 'exit', callback: (code: number) => void): void;
}

/** Serializes speaker inference through a dedicated Electron utility process. */
export class SpeakerEmbeddingRunner {
  private child: Child | null = null;
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (value: number[]) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private readonly entryPath: string, private readonly appRoot: string, private readonly spawn: (entry: string) => Child = entry => utilityProcess.fork(entry, [], { serviceName: 'sulla-speaker-embedding' }) as unknown as Child) {}
  run(modelPath: string, audio: Float32Array, sampleRate = 16_000): Promise<number[]> {
    const child = this.getChild();
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Speaker inference timed out')); }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      try { child.postMessage({ id, modelPath, audio, sampleRate, appRoot: this.appRoot }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error as Error); }
    });
  }
  private getChild(): Child {
    if (this.child) return this.child;
    const child = this.spawn(this.entryPath);
    this.child = child;
    child.on('message', message => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.ok && message.embedding) pending.resolve(message.embedding);
      else pending.reject(new Error(message.error || 'Speaker embedding failed'));
    });
    child.on('exit', code => {
      if (this.child === child) this.child = null;
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer); this.pending.delete(id);
        pending.reject(new Error(`Speaker utility process exited (${code})`));
      }
    });
    return child;
  }
}
