// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { postgresClient } from '../database/PostgresClient';
import type { BindingKind, BindingTarget, ChannelName, ConversationBinding, ConversationBindingRepository } from './types';
interface BindingRow { kind: BindingKind; channel_type: ChannelName; workspace_id: string; conversation_id: string; thread_key: string | null; sender_id: string | null; target_kind: 'chat' | 'job'; thread_id: string | null; job_id: string | null; task_index: number | null; agent_id: string | null }
export class PostgresConversationBindingRepository implements ConversationBindingRepository {
  constructor(private readonly db = postgresClient) {}
  async findThread(channel: ChannelName, workspaceId: string, conversationId: string, threadKey: string): Promise<ConversationBinding | null> {
    const row = await this.db.queryOne<BindingRow>(`SELECT * FROM conversation_bindings WHERE kind='thread_reply' AND channel_type=$1 AND workspace_id=$2 AND conversation_id=$3 AND thread_key=$4`, [channel,workspaceId,conversationId,threadKey]); return row ? this.map(row) : null;
  }
  async findFallback(kind: 'dm_person' | 'inbox', channel: ChannelName, workspaceId: string, senderId?: string): Promise<ConversationBinding | null> {
    const row = await this.db.queryOne<BindingRow>(`SELECT * FROM conversation_bindings WHERE kind=$1 AND channel_type=$2 AND workspace_id=$3 AND (($1='dm_person' AND sender_id=$4) OR ($1='inbox' AND sender_id IS NULL)) ORDER BY created_at LIMIT 1`, [kind,channel,workspaceId,senderId ?? null]); return row ? this.map(row) : null;
  }
  async save(binding: ConversationBinding): Promise<ConversationBinding> {
    const result = await this.db.queryOne<BindingRow>(`INSERT INTO conversation_bindings(kind,channel_type,workspace_id,conversation_id,thread_key,sender_id,target_kind,thread_id,job_id,task_index,agent_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING *`, [binding.kind,binding.channel,binding.workspaceId,binding.conversationId,binding.threadKey ?? null,binding.senderId ?? null,binding.target.kind,binding.target.kind==='chat'?binding.target.threadId:null,binding.target.kind==='job'?binding.target.jobId:null,binding.target.kind==='job'?binding.target.taskIndex ?? null:null,binding.agentId ?? null]);
    if (result) return this.map(result);
    const existing = binding.kind === 'thread_reply' && binding.threadKey ? await this.findThread(binding.channel,binding.workspaceId,binding.conversationId,binding.threadKey) : await this.findFallback(binding.kind,binding.channel,binding.workspaceId,binding.senderId);
    if (!existing) throw new Error('Conversation binding conflict could not be resolved'); return existing;
  }
  async claimReceipt(channel: ChannelName, eventId: string): Promise<boolean> { const result = await this.db.queryOne<{event_id:string}>(`INSERT INTO inbound_receipts(channel_type,event_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING event_id`, [channel,eventId]); return !!result; }
  private map(row: BindingRow): ConversationBinding {
    const target: BindingTarget = row.target_kind === 'chat' && row.thread_id ? {kind:'chat',threadId:row.thread_id} : row.job_id ? {kind:'job',jobId:row.job_id,...(row.task_index === null ? {} : {taskIndex:row.task_index})} : (()=>{throw new Error('Invalid persisted channel target')})();
    return {kind:row.kind,channel:row.channel_type,workspaceId:row.workspace_id,conversationId:row.conversation_id,...(row.thread_key?{threadKey:row.thread_key}:{}),...(row.sender_id?{senderId:row.sender_id}:{}),target,...(row.agent_id?{agentId:row.agent_id}:{})};
  }
}
