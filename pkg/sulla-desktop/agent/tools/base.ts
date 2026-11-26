// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// src/tools/base.ts
import { ToolResult } from '../types';
import { toolRequiresHostAccess } from './util/hostAccessPolicy';
import { requiresApproval as requiresToolApproval, type ToolSideEffect } from './toolPlacement';
import { ToolApprovalGate } from './ToolApprovalGate';
import { toolDecisionPort } from './toolDecisionPort';
import { DecisionAnswererLabel } from '../services/DecisionAnswererLabel';

import type { ChatToolActivity } from './ChatToolReporting';
import type { ToolExecutionContext } from './executionContext';

export type ToolOperation = 'read' | 'create' | 'update' | 'delete' | 'execute';

export interface ToolMetadata extends Record<string, unknown> {
  category:          string;
  requiresApproval?: boolean;
  isReadOnly?:       boolean;
  operationTypes?:   ToolOperation[];
}

type FieldType = 'string' | 'number' | 'boolean' | 'enum' | 'array' | 'object' | 'any';

export interface FieldSchema {
  type:         FieldType;
  enum?:        string[];
  items?:       FieldSchema;
  properties?:  Record<string, FieldSchema>;
  description?: string;
  default?:     unknown;
  optional?:    boolean;
  nullable?:    boolean;
}

export type InputSchemaDef = Record<string, FieldSchema>;

type ParsedInput = Record<string, unknown>;

export interface ToolResponse {
  successBoolean: boolean;
  responseString: string;
  /** Optional structured payload; BaseTool exposes it without double encoding. */
  result?: unknown;
  status?: number;
  retryAfter?: string;
}

export interface ToolRegistration {
  name:            string;
  description:     string;
  category:        string;
  schemaDef?:      InputSchemaDef;
  workerClass:     new () => BaseTool;
  operationTypes?: ToolOperation[];
}

interface ChatToolReportingState {
  metadata?: {
    threadId?:           string;
    wsChannel?:           string;
    _muteWsChat?:          boolean;
    subconsciousSilent?:  boolean;
  };
}

export abstract class BaseTool<TState extends ChatToolReportingState = any> {
  private readonly answererLabels = new DecisionAnswererLabel();
  abstract name: string;
  abstract description: string;
  schemaDef: InputSchemaDef = {};

  metadata:          ToolMetadata = { category: 'general' };
  /** Verified caller identity for containerized or relayed execution. */
  executionContext?: ToolExecutionContext;
  /** Absolute wall-clock deadline shared by transports and broker retries. */
  deadlineAt?: number;

  // ─────────────────────────────────────────────────────────────
  // Runtime validation + JSON schema generation
  // ─────────────────────────────────────────────────────────────

  protected parseInput(raw: unknown): ParsedInput {
    const result: ParsedInput = {};
    const errors: string[] = [];
    let source: any = raw;

    if (typeof source === 'string') {
      try {
        source = JSON.parse(source);
      } catch {
        source = { raw: source };
      }
    }

    if (source && typeof source === 'object' && !Array.isArray(source)) {
      const nestedInput = source.input;
      if (nestedInput && typeof nestedInput === 'object' && !Array.isArray(nestedInput)) {
        const topLevelHasSchemaFields = Object.keys(this.schemaDef).some((key) => source[key] !== undefined);
        const nestedHasSchemaFields = Object.keys(this.schemaDef).some((key) => nestedInput[key] !== undefined);
        if (!topLevelHasSchemaFields && nestedHasSchemaFields) {
          source = nestedInput;
        }
      }
    }

    for (const [key, spec] of Object.entries(this.schemaDef)) {
      const value = source?.[key];

      if (value === undefined || value === null) {
        if (!spec.optional) errors.push(`Missing required field: ${ key }`);
        if (spec.default !== undefined) result[key] = spec.default;
        continue;
      }

      switch (spec.type) {
      case 'string':
        if (typeof value !== 'string') errors.push(`Invalid type for ${ key }: expected string`);
        result[key] = String(value);
        break;
      case 'number': {
        const num = Number(value);
        if (isNaN(num)) errors.push(`Invalid number for ${ key }`);
        result[key] = num;
        break;
      }
      case 'boolean':
        result[key] = !!value;
        break;
      case 'enum':
        if (!spec.enum?.includes(value as string)) {
          errors.push(`Invalid value for ${ key }: must be one of ${ spec.enum?.join(', ') }`);
        }
        result[key] = value;
        break;
      case 'array':
        {
          let parsedArray: unknown = value;
          if (typeof value === 'string') {
            try {
              parsedArray = JSON.parse(value);
            } catch {
              // Not valid JSON — wrap the raw string into a single-element array
              // using the items schema to determine the correct shape.
              const itemsSpec = spec.items as Record<string, unknown> | undefined;
              if (itemsSpec?.type === 'object' && itemsSpec.properties) {
                // Find the first required string property to assign the value to
                const props = itemsSpec.properties as Record<string, { type: string; optional?: boolean }>;
                const targetKey = Object.keys(props).find(k => props[k].type === 'string' && !props[k].optional) ?? Object.keys(props)[0];
                parsedArray = [{ [targetKey]: value }];
              } else {
                parsedArray = [value];
              }
            }
          }
          if (!Array.isArray(parsedArray)) {
            // Wrap non-array values (e.g. a single object) into an array
            parsedArray = [parsedArray];
          }
          result[key] = parsedArray;
        }
        break;
      case 'object':
        {
          let parsedObject: unknown = value;
          if (typeof value === 'string') {
            try {
              parsedObject = JSON.parse(value);
            } catch {
              errors.push(`Invalid JSON object for ${ key }`);
            }
          }
          if (typeof parsedObject !== 'object' || parsedObject === null || Array.isArray(parsedObject)) {
            errors.push(`Expected object for ${ key }`);
          }
          result[key] = parsedObject;
        }
        break;
      case 'any':
        result[key] = value;
        break;
      }
    }

    if (errors.length) throw new Error(`Input validation failed:\n${ errors.join('\n') }`);

    return result;
  }

  protected get jsonSchema(): any {
    const properties: Record<string, any> = {};
    const required: string[] = [];

    for (const [key, spec] of Object.entries(this.schemaDef)) {
      const field: any = { description: spec.description || '' };

      switch (spec.type) {
      case 'string': field.type = 'string'; break;
      case 'number': field.type = 'number'; break;
      case 'boolean': field.type = 'boolean'; break;
      case 'enum':
        field.type = 'string';
        field.enum = spec.enum;
        break;
      case 'array':
        field.type = 'array';
        if (spec.items) field.items = this.fieldToJsonSchema(spec.items);
        break;
      case 'object':
        field.type = 'object';
        if (spec.properties) {
          field.properties = Object.fromEntries(
            Object.entries(spec.properties).map(([k, v]) => [k, this.fieldToJsonSchema(v)]),
          );
        }
        break;
      case 'any': break;
      }

      if (spec.default !== undefined) field.default = spec.default;
      properties[key] = field;
      if (!spec.optional) required.push(key);
    }

    return {
      type:                 'object',
      properties,
      required,
      additionalProperties: false,
    };
  }

  private fieldToJsonSchema(spec: FieldSchema): any {
    const field: any = spec.type === 'any' ? {} : { type: spec.type === 'enum' ? 'string' : spec.type };
    if (spec.enum) field.enum = spec.enum;
    if (spec.description) field.description = spec.description;
    if (spec.type === 'array' && spec.items) field.items = this.fieldToJsonSchema(spec.items);
    if (spec.type === 'object' && spec.properties) {
      field.properties = Object.fromEntries(
        Object.entries(spec.properties).map(([key, value]) => [key, this.fieldToJsonSchema(value)]),
      );
      field.required = Object.entries(spec.properties).filter(([, value]) => !value.optional).map(([key]) => key);
      field.additionalProperties = false;
    }
    return field;
  }

  // LangChain / agent compatible shape (no inheritance needed)
  get lc_kwargs() {
    return {
      name:        this.name,
      description: this.description,
      parameters:  this.jsonSchema,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Execution entry point
  // ─────────────────────────────────────────────────────────────

  public approvalSignal?: AbortSignal;

  async call(rawInput: unknown): Promise<ToolResult> {
    const parsed = this.parseInput(rawInput);
    // Jest's native-ESM VM context does not expose Node's global structuredClone.
    // Tool inputs are schema-validated plain data, so JSON cloning is a safe
    // compatibility fallback for that runtime.
    const clone = typeof globalThis.structuredClone === 'function'
      ? globalThis.structuredClone.bind(globalThis)
      : <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
    const validated = clone(parsed);
    const metadata = (this.state as any)?.metadata;
    const emit = this.sendChatMessage;
    let decisionAttribution: string | undefined;
    const signals = [this.approvalSignal, metadata?.options?.abort?.signal].filter(Boolean) as AbortSignal[];
    const signal = signals.length ? AbortSignal.any(signals) : undefined;
    try {
      if (toolRequiresHostAccess(this.metadata.category, this.name)) {
        const { isHostAccessEnabled, HOST_ACCESS_DISABLED_MESSAGE } = await import('./util/hostAccess');
        if (!await isHostAccessEnabled()) {
          return { toolName: this.name, success: false, error: HOST_ACCESS_DISABLED_MESSAGE };
        }
      }

      const operations = this.metadata.operationTypes ?? [];
      const sideEffect = (metadata?.sideEffect as ToolSideEffect | undefined) ?? (operations.length && operations.every(operation => operation === 'read') ? 'read' : undefined);
      const relayedWrite = metadata?.relayed === true && requiresToolApproval(sideEffect, { relayed: true });
      const initialSteerRevision = metadata?.reportingSteerRevision;
      const decision = await new ToolApprovalGate(toolDecisionPort.resolve()).check({
        name: this.name, category: this.metadata.category, conversationId: metadata?.threadId, channel: metadata?.wsChannel,
        signal, requiredByRelay: relayedWrite,
        onPending: async(record) => {
          await emit?.('Review the tool call in this conversation before approving.', 'tool_approval', {
            toolApproval: { approvalId: record.id, toolName: this.name, reason: record.title, command: this.name },
          });
        },
      });
      if (decision) {
        const { record, answer } = decision;
        // The result belongs to this invocation's live graph, not to the
        // next text that happened to arrive after a card changed state.
        if (metadata?.threadId && !signal?.aborted && metadata.reportingSteerRevision === initialSteerRevision &&
          (answer.status === 'approved' || answer.status === 'denied')) {
          metadata.reportingDecisionFollowUp = { id: record.id, threadId: metadata.threadId };
        }
        const answerer = this.answererLabels.label(answer.answeredBy);
        if (answer.status !== 'approved') return { toolName: this.name, success: false, error: `Action ${ answer.status }${ answerer ? ` by ${ answerer }` : '' }; nothing was executed.` };
        if (answerer) decisionAttribution = `Approved by ${ answerer }.`;
      }
      if (signal?.aborted) throw new Error('Action cancelled; nothing was executed.');
      const response = await this._validatedCall(validated);
      const { successBoolean, responseString, ...extra } = response as any;
      return {
        toolName: this.name,
        success:  successBoolean,
        result:   decisionAttribution ? `${ responseString }\n${ decisionAttribution }` : responseString,
        ...extra,
      };
    } catch (error) {
      return {
        toolName: this.name,
        success:  false,
        error:    error instanceof Error ? error.message : String(error),
      };
    }
  }

  async invoke(input: unknown, state?: TState): Promise<ToolResult> {
    if (state) {
      this.setState(state);
    }
    return this.call(input);
  }

  protected abstract _validatedCall(input: ParsedInput): Promise<ToolResponse>;

  // ─────────────────────────────────────────────────────────────
  // Existing helpers
  // ─────────────────────────────────────────────────────────────

  /** Emit a file reference to the originating visible chat, preserving delivery failures. */
  protected async emitInlineFileReference(record: unknown): Promise<void> {
    const metadata = this.state?.metadata;
    const threadId = metadata?.threadId;
    const send = this.sendChatMessage;
    const authorized = !!threadId && (!this.executionContext?.thread_id || this.executionContext.thread_id === threadId)
      && !metadata?._muteWsChat && !metadata?.subconsciousSilent;
    if (!authorized) throw new Error('Inline file references require an authorized chat thread');
    if (!send) throw new Error('Inline file reference chat transport is unavailable');
    const sent = await send('', 'inline_file_reference', { inlineFileReference: record });
    if (sent !== true) throw new Error('Inline file reference was not delivered');
  }

  /** Bind activity to the invocation's trusted originating thread, never a selected chat or tool argument. */
  protected bindChatToolActivity(): (activity: ChatToolActivity) => Promise<void> {
    const metadata = this.state?.metadata;
    const threadId = metadata?.threadId;
    const channel = metadata?.wsChannel;
    const send = this.sendChatMessage;
    const authorized = threadId && (!this.executionContext?.thread_id || this.executionContext.thread_id === threadId)
      && !metadata?._muteWsChat && !metadata?.subconsciousSilent;
    return async(activity) => {
      if (!authorized) return;
      try {
        if (send) {
          await send('', 'chat_tool_activity', { chatToolActivity: activity });
        } else if (channel) {
          const { getWebSocketClientService } = await import('../services/WebSocketClientService');
          await getWebSocketClientService().send(channel, {
            type: 'assistant_message',
            data: { role: 'assistant', kind: 'chat_tool_activity', thread_id: threadId, chatToolActivity: activity },
          });
        }
      } catch { /* Reporting must not change the actual tool result. */ }
    };
  }

  public sendChatMessage?: (content: string, kind?: string, extras?: Record<string, unknown>) => Promise<boolean>;
  public emitProgress?:    (data: any) => Promise<void>;

  protected async emitMessage(content: string, kind = 'progress', extras?: Record<string, unknown>) {
    return this.sendChatMessage?.(content, kind, extras) ?? false;
  }

  protected async emitProgressUpdate(data: any) {
    await this.emitProgress?.(data);
  }

  protected state: TState | null = null;
  setState(state: TState) { this.state = state }
}
