/** @jest-environment node */
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  SullaFilesSystemIngestJob,
  SYSTEM_INGEST_LANES,
  type SystemIngestDeps,
  type SystemIngestDirent,
  type SystemIngestFs,
  type SystemIngestLaneConfig,
  type SystemIngestLaneId,
  type SystemIngestOptions,
  type SystemIngestRequest,
  type SystemIngestSource,
  type SystemIngestStat,
} from '../sullaFilesSystemIngest';

type Node = { type: 'dir' } | { type: 'file'; content: string; size?: number; mtimeMs: number; ino: number } | { type: 'link' };

const OLD = Date.now() - 60 * 60_000;
let inoSeq = 1;

/** In-memory fs whose promises settle on microtasks only, so it never turns the event loop by itself. */
class MemoryFs implements SystemIngestFs {
  readonly nodes = new Map<string, Node>();
  private readonly children = new Map<string, Set<string>>();

  dir(dir:string):void {
    let current = dir;
    while (current !== '/' && !this.nodes.has(current)) {
      this.nodes.set(current, { type: 'dir' });
      const parent = path.dirname(current);
      if (!this.children.has(parent)) this.children.set(parent, new Set());
      this.children.get(parent)!.add(current);
      current = parent;
    }
  }

  private add(file:string, node:Node):void {
    this.dir(path.dirname(file));
    this.nodes.set(file, node);
    const parent = path.dirname(file);
    if (!this.children.has(parent)) this.children.set(parent, new Set());
    this.children.get(parent)!.add(file);
  }

  file(file:string, content:string, mtimeMs = OLD, size?:number):void {
    const existing = this.nodes.get(file);
    this.add(file, { type: 'file', content, size, mtimeMs, ino: existing?.type === 'file' ? existing.ino : inoSeq++ });
  }

  link(file:string):void { this.add(file, { type: 'link' }) }

  readFile(file:string):Promise<Buffer> {
    const node = this.nodes.get(file);
    if (node?.type !== 'file') return Promise.reject(new Error('gone'));
    return Promise.resolve(Buffer.from(node.content));
  }

  readdir(directory:string):Promise<SystemIngestDirent[]> {
    if (this.nodes.get(directory)?.type !== 'dir') return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    return Promise.resolve([...this.children.get(directory) ?? []].map(name => {
      const node = this.nodes.get(name)!;
      return {
        name:           path.basename(name),
        isFile:         () => node.type === 'file',
        isDirectory:    () => node.type === 'dir',
        isSymbolicLink: () => node.type === 'link',
      };
    }));
  }

  lstat(file:string):Promise<SystemIngestStat> {
    const node = this.nodes.get(file);
    if (!node) return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    return Promise.resolve({
      size:           node.type === 'file' ? node.size ?? Buffer.byteLength(node.content) : 0,
      mtimeMs:        node.type === 'file' ? node.mtimeMs : 0,
      ino:            node.type === 'file' ? node.ino : 0,
      isFile:         () => node.type === 'file',
      isSymbolicLink: () => node.type === 'link',
    });
  }
}

interface IngestRecord { path: string; lane: SystemIngestLaneId; at: number; skipSearchIndex: boolean }

/** Fake Files service + source gateway with read/ingest accounting. */
class FakeFiles {
  /** What the fake Files service holds: path -> content hash of the current version. */
  readonly stored = new Map<string, string>();
  unchangedCalls = 0;
  readonly reads:   string[] = [];
  readonly ingests: IngestRecord[] = [];
  readonly handles = new Map<string, string>();
  readDelayMs = 0;
  ingestDelayMs = 0;
  inflight = 0;
  maxInflight = 0;
  ingestInflight = 0;
  onIngest?:        (request:SystemIngestRequest) => void;

  constructor(private readonly memory:MemoryFs) {}

  get paths():string[] { return this.ingests.map(record => record.path) }

  restart():void {
    // A new Electron process: no gateway registrations survive.
    this.handles.clear();
  }

  private delay(ms:number):Promise<void> {
    return ms ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();
  }

  deps(sources:SystemIngestSource[], extra:Partial<SystemIngestDeps> = {}):SystemIngestDeps {
    return {
      sources:        () => sources,
      fetchAreas:     () => Promise.resolve([{ id: 'c-sulla', systemArea: 'sulla' }]),
      fs:             {
        readdir:  directory => this.memory.readdir(directory),
        lstat:    file => this.memory.lstat(file),
        readFile: async file => {
          this.reads.push(file);
          this.inflight++;
          this.maxInflight = Math.max(this.maxInflight, this.inflight);
          try {
            await this.delay(this.readDelayMs);
          } finally { this.inflight-- }
          const node = this.memory.nodes.get(file);
          if (node?.type !== 'file') throw new Error('gone');
          return Buffer.from(node.content);
        },
      },
      ingest: async(request:SystemIngestRequest) => {
        this.onIngest?.(request);
        this.ingestInflight++;
        try { await this.delay(this.ingestDelayMs) } finally { this.ingestInflight-- }
        const key = `${ request.collectionId }:${ request.filesPath }`;
        // Like the Files service: identical bytes for the current version are a no-op (no new version).
        if (this.stored.get(key) === request.snapshot.contentHash) { this.unchangedCalls++; return { unchanged: true } }
        this.stored.set(key, request.snapshot.contentHash);
        this.ingests.push({ path: request.filesPath, lane: request.lane, at: Date.now(), skipSearchIndex: request.skipSearchIndex });
        return { unchanged: false };
      },
      active: () => true,
      ...extra,
    };
  }
}

const UNLIMITED:Partial<SystemIngestLaneConfig> = { filesPerSecond: 1e9, bytesPerSecond: 1e15, idleIntervalMs: 1e9 };
const lanes = (overrides:Partial<Record<SystemIngestLaneId, Partial<SystemIngestLaneConfig>>> = {}) => ({
  sulla: { ...UNLIMITED, ...overrides.sulla },
});
const FAST:Partial<SystemIngestOptions> = {
  startupGraceMs: 0, unlockSettleMs: 0, resumePauseMs: 5, nudgeDelayMs: 0, recentWriteMs: 2_000, logIntervalMs: 0, customerRetryMs: 5, backpressurePauseMs: 20, lanes: lanes(),
};

async function waitFor(condition:() => boolean, timeoutMs = 15_000):Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

/** Starts (or nudges) the job and waits for exactly one more pass to finish. */
async function onePass(job:SullaFilesSystemIngestJob, trigger:'start' | 'nudge' = 'nudge'):Promise<void> {
  const before = job.status().passes;
  if (trigger === 'start') job.start(); else job.nudge();
  await waitFor(() => job.status().passes > before && job.status().state !== 'running');
  await job.idle();
}

describe('SullaFilesSystemIngestJob', () => {
  let memory:MemoryFs;
  let files:FakeFiles;
  let tmp:string;
  let docs:SystemIngestSource;
  let useCases:SystemIngestSource;
  const jobs:SullaFilesSystemIngestJob[] = [];
  const make = (sources:SystemIngestSource[], options:Partial<SystemIngestOptions> = {}, extra:Partial<SystemIngestDeps> = {}, fake = files) => {
    const job = new SullaFilesSystemIngestJob(fake.deps(sources, extra), { ...FAST, ...options });
    jobs.push(job);
    return job;
  };
  const addDocs = (count:number) => { for (let index = 0; index < count; index++) memory.file(`/docs/d${ index % 7 }/f${ String(index).padStart(5, '0') }.md`, `doc ${ index }`, OLD + index); };

  beforeEach(async() => {
    memory = new MemoryFs();
    files = new FakeFiles(memory);
    memory.dir('/docs');
    memory.dir('/skills');
    tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sulla-system-ingest-'));
    docs = { area: 'sulla', lane: 'sulla', root: '/docs', prefix: 'Docs/', filter: () => true };
    useCases = { area: 'sulla', lane: 'sulla', root: '/skills', prefix: 'Use Cases/skills/', filter: () => true };
  });

  afterEach(async() => {
    jest.useRealTimers();
    await Promise.all(jobs.splice(0).map(job => job.pause()));
    await fs.promises.rm(tmp, { recursive: true, force: true });
  });

  it('does not start the first pass before the startup delay', async() => {
    addDocs(3);
    let fetched = 0;
    const job = make([docs], { startupGraceMs: 300, unlockSettleMs: 50 }, {
      uptimeMs:   () => 0,
      fetchAreas: () => { fetched++; return Promise.resolve([{ id: 'c-sulla', systemArea: 'sulla' }]) },
    });
    job.start();
    job.nudge(); // a watched-file change must not pull the first pass forward
    expect(job.status().state).toBe('scheduled');
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(fetched).toBe(0);
    expect(files.reads).toHaveLength(0);
    await waitFor(() => files.ingests.length === 3 && job.status().state === 'scheduled');
    expect(fetched).toBeGreaterThanOrEqual(1);
  });

  it('skips unchanged files by stat without reading them and re-reads only changed ones', async() => {
    addDocs(20);
    const job = make([docs]);
    await onePass(job, 'start');
    expect(files.reads).toHaveLength(20);
    expect(files.ingests).toHaveLength(20);

    await onePass(job);
    expect(files.reads).toHaveLength(20);
    expect(job.status().skippedUnchanged).toBe(20);

    memory.file('/docs/d3/f00003.md', 'doc 3 appended', OLD + 99);
    await onePass(job);
    expect(files.reads.slice(20)).toEqual(['/docs/d3/f00003.md']);
    expect(files.paths.slice(20)).toEqual(['Docs/d3/f00003.md']);
  });

  it('defers files written within the last two seconds and keeps security skips', async() => {
    memory.file('/docs/hot.md', 'still writing', Date.now());
    memory.file('/docs/wallet.json', 'secret');
    memory.file('/docs/vault/key', 'secret');
    memory.file('/docs/master.key', 'secret');
    memory.link('/docs/link.md');
    memory.file('/skills/.git/config', 'x');
    memory.file('/skills/one/SKILL.md', 'skill');
    const job = make([docs, { ...useCases, ignore: rel => rel.split('/').includes('.git') }]);
    await onePass(job, 'start');
    expect(files.reads).toEqual(['/skills/one/SKILL.md']);
    expect(job.status().lanes.sulla.deferred).toBe(1);
  });

  it('stops a pass at its time budget and resumes later without re-ingesting finished files', async() => {
    addDocs(60);
    files.readDelayMs = 5;
    const job = make([docs], { passBudgetMs: 40 });
    await onePass(job, 'start');
    const firstPass = files.ingests.length;
    expect(firstPass).toBeGreaterThan(0);
    expect(firstPass).toBeLessThan(60);
    expect(job.status().lanes.sulla.remaining).toBe(60 - firstPass);
    await waitFor(() => Boolean(job.status().lanes.sulla.lastCompletedSweepAt));
    expect(job.status().passes).toBeGreaterThan(1);
    expect(files.ingests).toHaveLength(60);
    expect(new Set(files.paths).size).toBe(60);
    expect(job.status().remaining).toBe(0);
  });

  it('persists progress so a restart resumes and later starts skip unchanged files', async() => {
    addDocs(40);
    memory.file('/skills/a/SKILL.md', 'a');
    files.readDelayMs = 5;
    const statePath = () => path.join(tmp, 'state.json');
    const first = make([docs, useCases], { passBudgetMs: 60 }, { statePath });
    await onePass(first, 'start');
    await first.pause(); // quit mid-sweep
    const done = files.ingests.length;
    expect(done).toBeGreaterThan(1);
    expect(done).toBeLessThan(41);
    const saved = JSON.parse(await fs.promises.readFile(statePath(), 'utf8'));
    expect(saved.lanes.sulla.inProgress).toBe(true);
    expect(Object.keys(saved.entries)).toHaveLength(done);

    files.restart();
    const second = make([docs, useCases], {}, { statePath });
    await onePass(second, 'start');
    // Every file is ingested exactly once across the restart.
    expect(files.ingests).toHaveLength(41);
    expect(new Set(files.paths).size).toBe(41);
    expect(second.status().lanes.sulla.lastCompletedSweepAt).toBeDefined();

    // Another app start with nothing changed: no file is read or re-ingested.
    await second.pause();
    files.restart();
    const readsBefore = files.reads.length;
    const third = make([docs, useCases], {}, { statePath });
    await onePass(third, 'start');
    expect(files.reads.slice(readsBefore)).toEqual([]);
    expect(files.ingests).toHaveLength(41);
    expect(files.unchangedCalls).toBe(0);
    expect(third.status().lanes.sulla.skippedUnchanged).toBe(41);
  });

  it('drops persisted lanes and cache entries this build no longer has', async() => {
    addDocs(2);
    const statePath = () => path.join(tmp, 'state.json');
    await fs.promises.writeFile(statePath(), JSON.stringify({
      v: 2, sig: 'old', lanes: { sulla: { sweep: 1, inProgress: false }, logs: { sweep: 4, inProgress: true } },
      entries: { 'c-logs:app/old.log': { z: 1, m: 1, i: 1, h: 'h', s: 4, l: 'logs' } },
    }));
    const job = make([docs], {}, { statePath });
    await onePass(job, 'start');
    await job.pause();
    const saved = JSON.parse(await fs.promises.readFile(statePath(), 'utf8'));
    expect(Object.keys(saved.lanes)).toEqual(['sulla']);
    expect(Object.values<any>(saved.entries).every(entry => entry.l === 'sulla')).toBe(true);
    expect(Object.keys(saved.entries)).toHaveLength(2);
  });

  it('holds no source handles and never asks Files for the native-source inventory', async() => {
    addDocs(50);
    memory.file('/skills/a/SKILL.md', 'a');
    const deps = files.deps([docs, useCases]);
    expect(Object.keys(deps)).not.toContain('fetchInventory');
    const job = make([docs, useCases]);
    await onePass(job, 'start');
    expect(files.ingests).toHaveLength(51);
    expect(files.handles.size).toBe(0); // every read handle was revoked immediately
  });

  it('a lost stat cache costs reads but never new versions: Files reports the bytes unchanged', async() => {
    addDocs(30);
    await onePass(make([docs]), 'start');
    expect(files.ingests).toHaveLength(30);
    files.restart();
    const fresh = make([docs]); // no statePath: nothing persisted
    await onePass(fresh, 'start');
    expect(files.ingests).toHaveLength(30);
    expect(files.unchangedCalls).toBe(30);
    expect(fresh.status().lanes.sulla.skippedUnchanged).toBe(30);
  });

  it('never overlaps passes and keeps each lane within its concurrency bound', async() => {
    for (let index = 0; index < 100; index++) memory.file(`/skills/s${ index }.md`, `s${ index }`);
    addDocs(100);
    files.readDelayMs = 2;
    const inflight:Record<string, number> = { sulla: 0 };
    const maxInflight:Record<string, number> = { sulla: 0 };
    files.ingestDelayMs = 2;
    files.onIngest = request => {
      inflight[request.lane]++;
      maxInflight[request.lane] = Math.max(maxInflight[request.lane], inflight[request.lane]);
      setTimeout(() => { inflight[request.lane]-- }, 2);
    };
    const job = make([useCases, docs]);
    job.start();
    await waitFor(() => files.reads.length > 10);
    for (let index = 0; index < 5; index++) { job.start(); job.nudge() }
    await waitFor(() => files.ingests.length === 200 && job.status().state !== 'running');
    await job.idle();
    expect(files.maxInflight).toBeLessThanOrEqual(SYSTEM_INGEST_LANES.sulla.concurrency);
    expect(maxInflight.sulla).toBe(SYSTEM_INGEST_LANES.sulla.concurrency);
    expect(job.status().passes).toBeGreaterThanOrEqual(1);
    expect(new Set(files.paths).size).toBe(200);
  });

  it('pause (lock/shutdown) stops an in-flight pass promptly', async() => {
    addDocs(2_000);
    files.readDelayMs = 5;
    const job = make([docs]);
    job.start();
    await waitFor(() => files.reads.length >= 9);
    const started = Date.now();
    await job.pause();
    expect(Date.now() - started).toBeLessThan(500);
    const reads = files.reads.length;
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(files.reads.length).toBe(reads);
    expect(reads).toBeLessThan(100);
    expect(job.status().state).toBe('paused');
  });

  it('yields to the event loop during a long scan that would otherwise run on microtasks only', async() => {
    addDocs(3_000);
    const job = make([docs]);
    let ticks = 0;
    let running = true;
    const tick = () => { ticks++; if (running) setImmediate(tick); };
    setImmediate(tick);
    let timerFired = false;
    setTimeout(() => { timerFired = true }, 1);
    await onePass(job, 'start');
    const ticksDuringPass = ticks;
    running = false;
    expect(files.ingests).toHaveLength(3_000);
    expect(timerFired).toBe(true);
    expect(ticksDuringPass).toBeGreaterThan(1_000); // roughly one turn per file
  });

  it('backs off when ingest calls are slow and stays at zero when they are fast', async() => {
    for (let index = 0; index < 5; index++) memory.file(`/skills/f${ index }.md`, `x${ index }`);
    files.ingestDelayMs = 30;
    const job = make([useCases], { slowCallMs: 10, maxBackoffMs: 400, lanes: lanes({ sulla: { concurrency: 1 } }) });
    const observed:number[] = [];
    files.onIngest = () => observed.push(job.status().backoffMs);
    await onePass(job, 'start');
    expect(observed.slice(0, 3)).toEqual([0, 250, 400]);
    expect(job.status().backoffMs).toBe(400);

    const fastFiles = new FakeFiles(memory);
    const fast = make([useCases], { slowCallMs: 10_000 }, {}, fastFiles);
    await onePass(fast, 'start');
    expect(fastFiles.ingests).toHaveLength(5);
    expect(fast.status().backoffMs).toBe(0);
  });

  it('rate-limits the lane with its token bucket', async() => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    const counts:Partial<Record<SystemIngestLaneId, number>> = {};
    for (const [lane, source, make500] of [
      ['sulla', useCases, (index:number) => memory.file(`/skills/s${ index }.md`, `s${ index }`)],
    ] as const) {
      for (let index = 0; index < 500; index++) make500(index);
      const fake = new FakeFiles(memory);
      const job = make([source], { lanes: { [lane]: { idleIntervalMs: 1e9 } } }, {}, fake); // production rates
      job.start();
      for (let elapsed = 0; elapsed < 10_000; elapsed += 20) {
        await jest.advanceTimersByTimeAsync(20);
        for (let turn = 0; turn < 4; turn++) await new Promise(resolve => setImmediate(resolve));
      }
      counts[lane] = fake.ingests.length;
      const paused = job.pause();
      await jest.advanceTimersByTimeAsync(500);
      await paused;
    }
    // 10 s at the configured rate plus at most a one-second burst.
    expect(counts.sulla).toBeGreaterThanOrEqual(95);
    expect(counts.sulla).toBeLessThanOrEqual(10 * 10 + 10);
  }, 60_000);

  it('caps a lane by bytes per second', async() => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    for (let index = 0; index < 100; index++) memory.file(`/docs/big${ index }.md`, `b${ index }`, OLD + index, 1024 * 1024);
    const job = make([docs], { lanes: lanes({ sulla: { filesPerSecond: 100, bytesPerSecond: 2 * 1024 * 1024 } }) });
    job.start();
    for (let elapsed = 0; elapsed < 10_000; elapsed += 20) {
      await jest.advanceTimersByTimeAsync(20);
      for (let turn = 0; turn < 4; turn++) await new Promise(resolve => setImmediate(resolve));
    }
    const count = files.ingests.length;
    const paused = job.pause();
    await jest.advanceTimersByTimeAsync(500);
    await paused;
    expect(count).toBeGreaterThanOrEqual(18);
    expect(count).toBeLessThanOrEqual(22); // 2 MB/s of 1 MB files + 2 MB burst
  }, 60_000);

  it('pauses a lane that yields to backpressure while the Files service is slow', async() => {
    for (let index = 0; index < 5; index++) memory.file(`/docs/c${ index }.md`, `c${ index }`);
    files.ingestDelayMs = 40;
    const job = make([docs], {
      backpressureLatencyMs: 20, latencyDecayMs: 1e9, slowCallMs: 10_000, backpressurePauseMs: 1e9, lanes: lanes({ sulla: { concurrency: 1, yieldsToBackpressure: true } }),
    });
    job.start();
    await waitFor(() => files.ingests.length === 1 && job.status().state === 'scheduled');
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(files.ingests).toHaveLength(1);
    expect(job.status()).toMatchObject({ backpressured: true });
    expect(job.status().lanes.sulla.pending).toBe(true);
  });

  it('ingests newest first when a lane is configured for it', async() => {
    const mtimes = [5, 1, 9, 3, 7, 2, 8];
    mtimes.forEach((offset, index) => memory.file(`/docs/x${ index }.md`, `x${ index }`, OLD + offset * 1_000));
    const job = make([docs], { lanes: lanes({ sulla: { order: 'newest' } }) });
    await onePass(job, 'start');
    const expected = mtimes.map((offset, index) => ({ offset, name: `Docs/x${ index }.md` })).sort((left, right) => right.offset - left.offset).map(entry => entry.name);
    expect(files.paths).toEqual(expected);
  });

  it('a flood of 20,000 files never delays a customer file by more than one in-flight ingest', async() => {
    addDocs(20_000);
    files.ingestDelayMs = 1;
    let customer = false;
    let startedDuringCustomer = 0;
    files.onIngest = () => { if (customer) startedDuringCustomer++; };
    const job = make([docs], { lanes: lanes({ sulla: { concurrency: 1 } }) }, { customerBusy: () => customer });
    job.start();
    await waitFor(() => files.ingests.length >= 100);
    customer = true; // a P0 file arrives mid-flood
    const inflightAtArrival = files.ingestInflight + files.inflight;
    const before = files.ingests.length;
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(inflightAtArrival).toBeLessThanOrEqual(1);
    expect(startedDuringCustomer).toBe(0);
    expect(files.ingests.length - before).toBeLessThanOrEqual(1);
    expect(job.status().customerBusy).toBe(true);
    customer = false;
    await waitFor(() => files.ingests.length >= before + 50);
  }, 60_000);

  it('reschedules after a lock/unlock cycle and reports per-lane status', async() => {
    addDocs(5);
    const job = make([docs]);
    await job.pause();
    expect(job.status().state).toBe('paused');
    await onePass(job, 'start');
    const status = job.status();
    expect(status).toMatchObject({ state: 'scheduled', ingested: 5, scanned: 5, remaining: 0 });
    expect(status.lanes.sulla).toMatchObject({ priority: 1, ingested: 5, limiter: { concurrency: SYSTEM_INGEST_LANES.sulla.concurrency } });
  });
});
