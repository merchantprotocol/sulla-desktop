// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export interface CustodyOwner { channel: string; threadId: string; agentId: string }
export type CustodyActor = { kind: 'human' } | ({ kind: 'agent' } & CustodyOwner);
export interface CustodyRecord extends CustodyOwner { jobId: string; taskIndex?: number; version: number; changedAt: Date }
export interface CustodyAuditRecord { jobId: string; taskIndex?: number; from: CustodyOwner; to: CustodyOwner; actor: CustodyActor; reason: string; version: number; changedAt: Date }
export type CustodyRefusalCode = 'not-found'|'forbidden'|'invalid-destination'|'cycle'|'no-op'|'lease-active'|'version-conflict';
export type CustodyMoveResult = { ok: true; previous: CustodyOwner; current: CustodyRecord } | { ok: false; code: CustodyRefusalCode; message: string; current?: CustodyOwner; retryable?: boolean };
export interface CustodyMoveInput { jobId: string; taskIndex?: number; to: CustodyOwner; actor: CustodyActor; reason: string }
export interface CustodyTransactionClient { query<T=any>(sql:string, values?:unknown[]):Promise<{rows:T[]}> }
export interface JobCustodyPort { move(input: CustodyMoveInput): Promise<CustodyMoveResult>; resolveOwner(jobId: string, taskIndex?: number): Promise<CustodyRecord|undefined>; withOwner<T>(jobId: string, taskIndex: number|undefined, operation: (client: CustodyTransactionClient, owner: CustodyRecord) => Promise<T>): Promise<T|undefined>; history(jobId: string): Promise<CustodyAuditRecord[]> }
export interface CustodyChangeNotifier { changed(change: CustodyAuditRecord): Promise<void> }
export class NoopCustodyChangeNotifier implements CustodyChangeNotifier { async changed(): Promise<void> {} }
