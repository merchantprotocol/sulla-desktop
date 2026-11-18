// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { RollingTimingWindow, type TimingSnapshot } from './RollingTimingWindow.js';

export interface FilesMetricsOptions {
  /** A single wait longer than this is logged on its own line. */
  slowWaitMs?:number;
  /** Samples kept per timing for the p50/p95 window. */
  window?:number;
  warn?:(message:string, fields:Record<string, unknown>) => void;
}

export interface FilesMetricsSnapshot {
  slowWaitThresholdMs:number;
  /** Time waiting to acquire a Postgres pool connection for a transaction. */
  poolWait:TimingSnapshot;
  /** Whole version staging: key lookup, encryption and every chunk write. */
  stage:TimingSnapshot;
  /** Each fsync'd chunk write inside staging. */
  chunkWrite:TimingSnapshot;
  /** Successful `fuse-*` transactions, from BEGIN to COMMIT (the locks and statements inside them). */
  txn:TimingSnapshot;
  /** Each RequestAuditLog.record call (the audit insert, including its savepoint when inside a transaction). */
  audit:TimingSnapshot;
  /** Whole handler time for the FUSE create (POST files), content PUT and replace routes, errors excluded. */
  fuseRoute:TimingSnapshot;
}

/**
 * Process-local Files timings for diagnosing EIOs: where a write waited (pool, staging, fsync).
 * Holds only numbers. Never record file names, paths or any user data here.
 */
export class FilesMetrics {
  readonly poolWait:RollingTimingWindow;
  readonly stage:RollingTimingWindow;
  readonly chunkWrite:RollingTimingWindow;
  readonly txn:RollingTimingWindow;
  readonly audit:RollingTimingWindow;
  readonly fuseRoute:RollingTimingWindow;
  private readonly slowWaitMs:number;
  private readonly warn:(message:string, fields:Record<string, unknown>) => void;

  constructor(options:FilesMetricsOptions = {}) {
    this.slowWaitMs = options.slowWaitMs ?? 500;
    this.warn = options.warn ?? ((message, fields) => console.warn(message, fields));
    const window = options.window ?? 512;
    this.poolWait = new RollingTimingWindow(window);
    this.stage = new RollingTimingWindow(window);
    this.chunkWrite = new RollingTimingWindow(window);
    this.txn = new RollingTimingWindow(window);
    this.audit = new RollingTimingWindow(window);
    this.fuseRoute = new RollingTimingWindow(window);
  }

  observePoolWait(ms:number):void { this.observe('pool-wait', this.poolWait, ms) }
  observeStage(ms:number):void { this.observe('stage', this.stage, ms) }
  observeChunkWrite(ms:number):void { this.observe('chunk-write', this.chunkWrite, ms) }
  /** Timing only: no slow-wait line, TransactionRunner already logs slow transactions. */
  observeTxn(ms:number):void { this.txn.record(ms) }
  observeAudit(ms:number):void { this.audit.record(ms) }
  observeFuseRoute(ms:number):void { this.fuseRoute.record(ms) }

  snapshot():FilesMetricsSnapshot {
    return {
      slowWaitThresholdMs: this.slowWaitMs,
      poolWait: this.poolWait.snapshot(),
      stage: this.stage.snapshot(),
      chunkWrite: this.chunkWrite.snapshot(),
      txn: this.txn.snapshot(),
      audit: this.audit.snapshot(),
      fuseRoute: this.fuseRoute.snapshot(),
    };
  }

  private observe(name:string, timings:RollingTimingWindow, ms:number):void {
    timings.record(ms);
    if (ms > this.slowWaitMs) this.warn(`[SullaFiles] slow ${ name }`, { name, waitMs: Math.round(ms), thresholdMs: this.slowWaitMs });
  }
}
