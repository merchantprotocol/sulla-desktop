// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { utilityProcess } from 'electron';

export interface OrtRequest { id: number; operation: 'vad' | 'smart-turn'; modelPath: string; audio: Float32Array; state?: Float32Array; threads: number }
export interface OrtResponse { id: number; ok: boolean; probability?: number; state?: Float32Array; error?: string }
interface Child { postMessage(message: OrtRequest): void; on(event: 'message', callback: (message: OrtResponse) => void): void; on(event: 'exit', callback: (code: number) => void): void }
/** Process boundary for CPU-only ONNX inference; pending calls are isolated by request id. */
export class OrtInferenceClient {
  private child: Child | null = null;
  private nextId = 0;
  private hasSpawned = false;
  private readonly pending = new Map<number, { child: Child; resolve: (value: OrtResponse) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly restarts: number[] = [];
  constructor(private readonly entryPath: string, private readonly timeoutMs = 5000, private readonly maxRestartsPerMinute = 3, private readonly threads = 1, private readonly spawn: (entry: string) => Child = entry => utilityProcess.fork(entry, [], { serviceName: 'sulla-voice-ort' }) as unknown as Child) {}
  async infer(request: Omit<OrtRequest, 'id' | 'threads'>): Promise<OrtResponse> {
    const child = this.getChild(); const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('ONNX inference timed out')); }, this.timeoutMs);
      this.pending.set(id, { child, resolve, reject, timer });
      try { child.postMessage({ ...request, id, threads: this.threads }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error as Error); }
    });
  }
  private getChild(): Child {
    if (this.child) return this.child;
    const now = Date.now(); while (this.restarts.length && now - this.restarts[0] > 60_000) this.restarts.shift();
    if (this.hasSpawned && this.restarts.length >= this.maxRestartsPerMinute) throw new Error('ONNX utility process restart limit reached');
    const proc = this.spawn(this.entryPath);
    if (this.hasSpawned) this.restarts.push(now);
    this.hasSpawned = true; this.child = proc;
    proc.on('message', message => { const entry = this.pending.get(message.id); if (!entry) return; clearTimeout(entry.timer); this.pending.delete(message.id); message.ok ? entry.resolve(message) : entry.reject(new Error(message.error || 'ONNX inference failed')); });
    proc.on('exit', code => { if (this.child === proc) this.child = null; for (const [id, entry] of this.pending) { if (entry.child !== proc) continue; clearTimeout(entry.timer); this.pending.delete(id); entry.reject(new Error(`ONNX utility process exited (${code})`)); } });
    return proc;
  }
}
