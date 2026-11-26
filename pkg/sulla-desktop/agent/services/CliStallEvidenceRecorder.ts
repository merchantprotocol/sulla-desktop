// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import * as fs from 'node:fs';
import path from 'node:path';

import type { ChatMessage } from '../languagemodels/BaseLanguageModel';
import type { AgentCliStallEvidence } from '../tools/agents/jobRegistry';
import type { RunLivenessClock, RunToolInFlight } from './RunLivenessClock';
import paths from '@pkg/utils/paths';

export interface CliStallEvidenceWriter {
  save(jobId: string, taskIndex: number, evidence: AgentCliStallEvidence): Promise<void>;
}

export interface CliStallEvidenceFileWriter {
  save(evidence: AgentCliStallEvidence): string;
}

/** Synchronously leaves the sanitized last stall record in the app logs directory. */
export class LocalCliStallEvidenceFileWriter implements CliStallEvidenceFileWriter {
  constructor(private readonly logsDirectory: () => string = () => paths.logs) {}

  save(evidence: AgentCliStallEvidence): string {
    const directory = this.logsDirectory();
    const fileName = `agent-cli-stall-${ this.safeSegment(evidence.provider) }-${ this.safeSegment(evidence.jobId) }-task-${ evidence.taskIndex }.json`;
    const filePath = path.join(directory, fileName);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(filePath, `${ JSON.stringify(evidence, null, 2) }\n`, { mode: 0o600 });
    return filePath;
  }

  private safeSegment(value: string): string {
    return value.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120) || 'unknown';
  }
}

export interface CliStallIdentity {
  provider: 'codex' | 'claude-code';
  jobId?: string;
  taskIndex?: number;
  threadId?: string;
}

export interface CliStallMemorySnapshot {
  processRssBytes: number | null;
  cgroupMemory: { currentBytes: number | null; maxBytes: number | 'max' | null } | null;
}

export interface CliStallMemoryReader {
  read(): CliStallMemorySnapshot;
}

export interface CliStallSnapshot {
  childPid: number | null;
  providerPid?: number | null;
  childAlive: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  promptLength: number;
  toolsInFlight: RunToolInFlight[];
  lastProviderRetry: { status: 429 | 503; at: number } | null;
  suspendMarks: { lastSuspendAt: number | null; lastResumeAt: number | null };
  messages?: ChatMessage[];
  sensitiveContent?: string[];
}

export interface CliStallRunSnapshot {
  child: { pid?: number; exitCode: number | null; signalCode?: NodeJS.Signals | null };
  providerPid?: number | null;
  stderr: string;
  promptLength: number;
  liveness: Pick<RunLivenessClock, 'toolsInFlightSnapshot' | 'suspendMarks'>;
  messages?: ChatMessage[];
}

/** Reads only bounded process/cgroup memory metadata; unreadable cgroup values remain null. */
export class NodeCliStallMemoryReader implements CliStallMemoryReader {
  read(): CliStallMemorySnapshot {
    return {
      processRssBytes: this.rssBytes(),
      cgroupMemory: this.cgroupMemory(),
    };
  }

  private rssBytes(): number | null {
    try { return process.memoryUsage().rss } catch { return null }
  }

  private cgroupMemory(): CliStallMemorySnapshot['cgroupMemory'] {
    const current = this.readNumber('/sys/fs/cgroup/memory.current') ?? this.readNumber('/sys/fs/cgroup/memory/memory.usage_in_bytes');
    const maxText = this.readText('/sys/fs/cgroup/memory.max') ?? this.readText('/sys/fs/cgroup/memory/memory.limit_in_bytes');
    const maxBytes = maxText === 'max' ? 'max' : maxText && /^\d+$/.test(maxText) ? Number(maxText) : null;
    return current === null && maxBytes === null ? null : { currentBytes: current, maxBytes };
  }

  private readText(path: string): string | null {
    try { return fs.readFileSync(path, 'utf8').trim() } catch { return null }
  }

  private readNumber(path: string): number | null {
    const value = this.readText(path);
    return value && /^\d+$/.test(value) ? Number(value) : null;
  }
}

/** Writes sanitized CLI stall evidence onto the existing durable job task JSON. */
export class AgentJobTaskCliStallEvidenceWriter implements CliStallEvidenceWriter {
  async save(jobId: string, taskIndex: number, evidence: AgentCliStallEvidence): Promise<void> {
    const registry = await import('../tools/agents/jobRegistry');
    await registry.updateJobTask(jobId, taskIndex, { cliStallEvidence: evidence });
    const saved = (await registry.getJob(jobId))?.tasks[taskIndex]?.cliStallEvidence;
    if (saved?.recordedAt !== evidence.recordedAt) throw new Error('CLI stall evidence was not persisted on the target task');
  }
}

/** Per-process history and durable evidence writer used by both CLI providers. */
export class CliStallEvidenceRecorder {
  private readonly events: Array<{ timestamp: string; type: string }> = [];
  private persisted = false;
  private localEvidencePath: string | null = null;
  private lastProviderRetry: { status: 429 | 503; at: number } | null = null;

  constructor(
    private readonly writer: CliStallEvidenceWriter,
    private readonly identity: CliStallIdentity,
    private readonly memory: CliStallMemoryReader = new NodeCliStallMemoryReader(),
    private readonly now: () => number = Date.now,
    private readonly localEvidenceWriter: CliStallEvidenceFileWriter = new LocalCliStallEvidenceFileWriter(),
  ) {}

  event(type: string, at = this.now()): void {
    this.events.push({ timestamp: this.iso(at), type: this.safeType(type) });
    if (this.events.length > 20) this.events.splice(0, this.events.length - 20);
  }

  providerRetry(status: 429 | 503, at = this.now()): void {
    this.lastProviderRetry = { status, at };
    this.event(`provider_retry_${ status }`, at);
  }

  pointer(): string | undefined {
    if (!this.identity.jobId || this.identity.taskIndex === undefined) return undefined;
    const location = this.persisted
      ? `Stall evidence is stored on task ${ this.identity.taskIndex } of job ${ this.identity.jobId }`
      : this.localEvidencePath
        ? `Local stall evidence is stored at ${ this.localEvidencePath }; the job task write is pending or failed`
        : `Stall evidence could not be confirmed on task ${ this.identity.taskIndex } of job ${ this.identity.jobId }`;
    return `${ location }; inspect check_agent_jobs(jobId="${ this.identity.jobId }") at tasks[${ this.identity.taskIndex }].cliStallEvidence.`;
  }

  failureMessage(message: string): string {
    const pointer = this.pointer();
    return pointer ? `${ message }\n${ pointer }` : message;
  }

  recordRunStall(snapshot: CliStallRunSnapshot): Promise<AgentCliStallEvidence | undefined> {
    const child = snapshot.child;
    return this.recordStall({
      childPid: child.pid ?? null,
      providerPid: snapshot.providerPid,
      childAlive: child.pid !== undefined && child.exitCode === null && (child.signalCode ?? null) === null,
      exitCode: child.exitCode,
      signal: child.signalCode ?? null,
      stderr: snapshot.stderr,
      promptLength: snapshot.promptLength,
      toolsInFlight: snapshot.liveness.toolsInFlightSnapshot(),
      lastProviderRetry: this.lastProviderRetry,
      suspendMarks: snapshot.liveness.suspendMarks(),
      messages: snapshot.messages,
    });
  }

  async recordStall(snapshot: CliStallSnapshot): Promise<AgentCliStallEvidence | undefined> {
    const { jobId, taskIndex, threadId, provider } = this.identity;
    if (!jobId || !Number.isInteger(taskIndex) || taskIndex! < 0 || !threadId) return undefined;
    const memory = this.memory.read();
    const evidence: AgentCliStallEvidence = {
      recordedAt: this.iso(this.now()), provider, jobId, taskIndex: taskIndex!, threadId,
      events: [...this.events],
      toolsInFlight: snapshot.toolsInFlight.map(tool => ({ name: this.safeType(tool.name), startedAt: this.iso(tool.startedAt) })),
      child: {
        pid: Number.isInteger(snapshot.childPid) ? snapshot.childPid : null,
        providerPid: Number.isInteger(snapshot.providerPid) ? snapshot.providerPid! : null,
        alive: snapshot.childAlive,
        exitCode: Number.isInteger(snapshot.exitCode) ? snapshot.exitCode : null,
        signal: typeof snapshot.signal === 'string' && /^SIG[A-Z0-9]+$/.test(snapshot.signal) ? snapshot.signal : null,
      },
      stderrSummary: this.stderrSummary(snapshot.stderr, snapshot.exitCode, snapshot.signal),
      lastProviderRetry: snapshot.lastProviderRetry
        ? { status: snapshot.lastProviderRetry.status, timestamp: this.iso(snapshot.lastProviderRetry.at) }
        : null,
      promptLength: Number.isFinite(snapshot.promptLength) ? Math.max(0, Math.trunc(snapshot.promptLength)) : 0,
      processRssBytes: memory.processRssBytes,
      cgroupMemory: memory.cgroupMemory,
      suspendMarks: {
        lastSuspendAt: snapshot.suspendMarks.lastSuspendAt === null ? null : this.iso(snapshot.suspendMarks.lastSuspendAt),
        lastResumeAt: snapshot.suspendMarks.lastResumeAt === null ? null : this.iso(snapshot.suspendMarks.lastResumeAt),
      },
      appStartedAt: this.iso(this.now() - process.uptime() * 1000),
    };
    try {
      this.localEvidencePath = this.localEvidenceWriter.save(evidence);
    } catch {
      // Keep the database write as a secondary path if the local disk is unavailable.
    }
    await this.writer.save(jobId, taskIndex!, evidence);
    this.persisted = true;
    return evidence;
  }

  private safeType(value: string): string {
    return String(value).replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 80) || 'unknown';
  }

  private stderrSummary(value: string, exitCode: number | null, signal: NodeJS.Signals | null): AgentCliStallEvidence['stderrSummary'] {
    const firstLine = value.split(/\r?\n/, 1)[0].trim();
    const namedError = firstLine.match(/^([A-Za-z][A-Za-z0-9_.]*(?:Error|Exception))\s*(?::|\b)/)?.[1];
    const genericError = /^error\s*:/i.test(firstLine) ? 'Error' : null;
    return {
      errorName: namedError ? this.safeType(namedError) : genericError,
      firstLine: firstLine ? '[omitted: stderr content excluded]' : null,
      exitCode: Number.isInteger(exitCode) ? exitCode : null,
      signal: typeof signal === 'string' && /^SIG[A-Z0-9]+$/.test(signal) ? signal : null,
    };
  }

  private iso(at: number): string {
    return Number.isFinite(at) ? new Date(at).toISOString() : new Date(this.now()).toISOString();
  }
}

export const durableCliStallEvidenceWriter = new AgentJobTaskCliStallEvidenceWriter();
