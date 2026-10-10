import { randomUUID } from 'node:crypto';

import Ajv from 'ajv';

import { postgresClient } from '../database/PostgresClient';
import { nextThreadId } from './GraphRegistry';
import { resolveRoutableAgent } from './ChatAgentRouting';
import { getWebSocketClientService } from './WebSocketClientService';

import { getWindow } from '@pkg/window';

export type AgentTabContractStatus = 'open' | 'returned' | 'cancelled';

export interface AgentTabContractSpec {
  name:         string;
  description?: string;
  schema?:      Record<string, unknown>;
}

export interface AgentTabContractRow {
  id:                string;
  parent_thread_id:  string;
  parent_channel:    string;
  parent_agent_id:   string;
  child_thread_id:   string;
  child_agent_id:    string;
  title:             string;
  brief:             string;
  contract_spec:     AgentTabContractSpec;
  status:            AgentTabContractStatus;
  result:            unknown;
  depth:             number;
  created_at:        string;
  returned_at:       string | null;
}

export const UI_TEST_ISSUES_SCHEMA: Record<string, unknown> = {
  type:                 'object',
  additionalProperties: false,
  required:             ['summary', 'issues'],
  properties:           {
    summary: {
      type:                 'object',
      additionalProperties: false,
      required:             ['pass', 'fail', 'blocked', 'notRun'],
      properties:           {
        pass:    { type: 'number' },
        fail:    { type: 'number' },
        blocked: { type: 'number' },
        notRun:  { type: 'number' },
      },
    },
    issues: {
      type:  'array',
      items: {
        type:                 'object',
        additionalProperties: false,
        required:             ['id', 'title', 'severity', 'url', 'steps', 'expected', 'actual', 'status'],
        properties:           {
          id:         { type: 'string' },
          title:      { type: 'string' },
          severity:   { type: 'string', enum: ['p0', 'p1', 'p2', 'p3'] },
          url:        { type: 'string' },
          steps:      { type: 'array', items: { type: 'string' } },
          expected:   { type: 'string' },
          actual:     { type: 'string' },
          screenshot: { type: 'string' },
          viewport:   { type: 'string' },
          status:     { type: 'string', enum: ['open'] },
        },
      },
    },
  },
};

const PRESETS: Record<string, AgentTabContractSpec> = {
  'ui-test-issues': {
    name:        'ui-test-issues',
    description: 'UI test totals and every issue found, with reproduction evidence.',
    schema:      UI_TEST_ISSUES_SCHEMA,
  },
};

function normalizeContract(input: unknown): AgentTabContractSpec {
  if (!input || typeof input !== 'object') return { name: 'result' };
  const raw = input as Record<string, unknown>;
  const name = String(raw.name ?? 'result').trim() || 'result';
  const preset = PRESETS[name];
  if (preset && !raw.schema) return preset;
  return {
    name,
    ...(typeof raw.description === 'string' && raw.description.trim() ? { description: raw.description.trim() } : {}),
    ...(raw.schema && typeof raw.schema === 'object' && !Array.isArray(raw.schema) ? { schema: raw.schema as Record<string, unknown> } : {}),
  };
}

function sendAgentCommand(payload: Record<string, unknown>): boolean {
  const agentWindow = getWindow('main-agent');
  if (!agentWindow) return false;
  const dispatch = () => agentWindow.webContents.send('agent-command', payload);
  if (agentWindow.webContents.isLoading()) agentWindow.webContents.once('did-finish-load', dispatch);
  else dispatch();
  return true;
}

function emitProactive(channel: string, threadId: string, headline: string, body: string): void {
  getWebSocketClientService().send(channel, {
    type: 'chat_message',
    data: {
      threadId,
      kind: 'proactive',
      role: 'assistant',
      headline,
      body,
      content: body,
    },
  });
}

function buildChildPrompt(parentName: string, contractId: string, brief: string, contract: AgentTabContractSpec): string {
  return `[Agent tab launched by ${ parentName }]\n\n${ brief }\n\n` +
    `Return contract ${ contractId } with chat/return_contract when the work is complete.\n` +
    `Contract name: ${ contract.name }\n` +
    `${ contract.description ? `Contract description: ${ contract.description }\n` : '' }` +
    `${ contract.schema ? `Expected JSON schema:\n${ JSON.stringify(contract.schema, null, 2) }` : 'No JSON schema was supplied; return a JSON object.' }`;
}

function formatContractResult(contract: AgentTabContractRow, result: any, summary?: string): string {
  const lines: string[] = [];
  if (summary?.trim()) lines.push(summary.trim());
  if (contract.contract_spec.name === 'ui-test-issues' && result && typeof result === 'object') {
    const counts = result.summary ?? {};
    lines.push(`PASS ${ counts.pass ?? 0 }  ·  FAIL ${ counts.fail ?? 0 }  ·  BLOCKED ${ counts.blocked ?? 0 }  ·  NOT RUN ${ counts.notRun ?? 0 }`);
    const issues = Array.isArray(result.issues) ? result.issues : [];
    if (issues.length === 0) lines.push('No issues found.');
    for (const issue of issues) {
      lines.push(`${ String(issue.severity ?? '').toUpperCase() } · ${ issue.id ?? 'issue' } · ${ issue.title ?? 'Untitled' }`);
      if (issue.url) lines.push(String(issue.url));
      if (issue.actual) lines.push(`Actual: ${ issue.actual }`);
      if (issue.expected) lines.push(`Expected: ${ issue.expected }`);
    }
  } else {
    lines.push(JSON.stringify(result, null, 2));
  }
  return lines.filter(Boolean).join('\n');
}

export class AgentTabContractService {
  async launch(input: {
    parentThreadId: string;
    parentChannel: string;
    parentAgentId: string;
    agentId: string;
    brief: string;
    title?: string;
    contract?: unknown;
    focus?: boolean;
  }): Promise<{ contractId: string; childThreadId: string }> {
    if (!input.brief.trim()) throw new Error('Agent-tab brief is required and cannot be empty.');
    const childAgent = await resolveRoutableAgent(input.agentId);
    if (!childAgent) throw new Error(`Agent "${ input.agentId }" does not exist, is disabled, or is archived.`);
    const parentAgent = await resolveRoutableAgent(input.parentAgentId);
    const parentName = parentAgent?.name ?? input.parentAgentId;
    const contract = normalizeContract(input.contract);
    if (contract.schema) {
      try {
        new Ajv({ strict: false }).compile(contract.schema);
      } catch (error) {
        throw new Error(`Contract schema is invalid: ${ (error as Error).message }`);
      }
    }
    const title = input.title?.trim() || childAgent.name;
    const id = randomUUID();
    const childThreadId = nextThreadId();

    const depth = await postgresClient.transaction(async(client) => {
      await client.query('LOCK TABLE agent_tab_contracts IN SHARE ROW EXCLUSIVE MODE');
      const inherited = await client.query<{ depth: number }>(
        'SELECT depth FROM agent_tab_contracts WHERE child_thread_id = $1 ORDER BY depth DESC LIMIT 1',
        [input.parentThreadId],
      );
      const nextDepth = Number(inherited.rows[0]?.depth ?? 0) + 1;
      if (nextDepth > 2) throw new Error('Agent-tab depth limit reached: a grandchild tab cannot launch another agent tab.');
      const open = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM agent_tab_contracts WHERE parent_thread_id = $1 AND status = 'open'`,
        [input.parentThreadId],
      );
      if (Number(open.rows[0]?.count ?? 0) >= 5) {
        throw new Error('Open agent-tab limit reached: this chat already has 5 open child contracts. Return or cancel one before launching another.');
      }
      await client.query(`
        INSERT INTO agent_tab_contracts (
          id, parent_thread_id, parent_channel, parent_agent_id, child_thread_id,
          child_agent_id, title, brief, contract_spec, depth
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
      `, [id, input.parentThreadId, input.parentChannel, input.parentAgentId, childThreadId,
        childAgent.graphAgentId, title, input.brief, JSON.stringify(contract), nextDepth]);
      return nextDepth;
    });

    const opened = sendAgentCommand({
      command: 'open-agent-chat-tab',
      threadId: childThreadId,
      agentId: childAgent.agentId,
      agentName: childAgent.name,
      title,
      parentThreadId: input.parentThreadId,
      parentAgentId: input.parentAgentId,
      parentAgentName: parentName,
      contractId: id,
      depth,
      focus: input.focus === true,
    });
    if (!opened) {
      await postgresClient.query(`UPDATE agent_tab_contracts SET status = 'cancelled' WHERE id = $1`, [id]);
      throw new Error('Sulla Desktop renderer is not available, so the agent tab could not be opened.');
    }

    const prompt = buildChildPrompt(parentName, id, input.brief, contract);
    // Give the renderer one event-loop turn to create and subscribe the visible tab.
    await new Promise(resolve => setTimeout(resolve, 50));
    emitProactive(input.parentChannel, childThreadId, `Launched by ${ parentName }`, prompt);
    await getWebSocketClientService().send(input.parentChannel, {
      type: 'user_message',
      data: {
        threadId: childThreadId,
        content: prompt,
        metadata: {
          agentId: childAgent.graphAgentId,
          source: 'agent_tab_brief',
          inputSource: 'system',
          contractId: id,
          parentThreadId: input.parentThreadId,
        },
      },
    });
    return { contractId: id, childThreadId };
  }

  async returnContract(childThreadId: string, contractId: string, result: unknown, summary?: string): Promise<AgentTabContractRow> {
    const contract = await postgresClient.queryOne<AgentTabContractRow>('SELECT * FROM agent_tab_contracts WHERE id = $1', [contractId]);
    if (!contract) throw new Error(`Contract "${ contractId }" was not found.`);
    if (contract.child_thread_id !== childThreadId) throw new Error('Only the child chat tab that owns this contract can return it.');
    if (contract.status !== 'open') throw new Error(`Contract "${ contractId }" is already ${ contract.status }.`);

    if (contract.contract_spec.schema) {
      const ajv = new Ajv({ allErrors: true, strict: false });
      let validate: ReturnType<Ajv['compile']>;
      try {
        validate = ajv.compile(contract.contract_spec.schema);
      } catch (error) {
        throw new Error(`Contract schema is invalid: ${ (error as Error).message }`);
      }
      if (!validate(result)) {
        const mismatch = ajv.errorsText(validate.errors, { separator: '; ' });
        throw new Error(`Contract result does not match the expected schema: ${ mismatch }`);
      }
    }

    const updated = await postgresClient.queryOne<AgentTabContractRow>(`
      UPDATE agent_tab_contracts
      SET status = 'returned', result = $2::jsonb, returned_at = now()
      WHERE id = $1 AND status = 'open'
      RETURNING *
    `, [contractId, JSON.stringify(result)]);
    if (!updated) throw new Error(`Contract "${ contractId }" was returned by another call.`);

    const body = formatContractResult(updated, result, summary);
    emitProactive(updated.parent_channel, updated.parent_thread_id, `${ updated.title } returned ${ updated.contract_spec.name }`, body);
    emitProactive(updated.parent_channel, updated.child_thread_id, 'Contract returned', `Returned ${ updated.contract_spec.name } to the parent chat.`);
    await getWebSocketClientService().send(updated.parent_channel, {
      type: 'inject_message',
      data: {
        threadId: updated.parent_thread_id,
        content: `[agent-tab contract ${ updated.id } returned by ${ updated.child_agent_id }]\n\n${ body }\n\nStructured result:\n${ JSON.stringify(result, null, 2) }`,
        metadata: {
          source: 'agent_tab_contract',
          inputSource: 'system',
          contractId: updated.id,
          result,
        },
      },
    });
    return updated;
  }

  async messageChild(parentThreadId: string, input: { contractId?: string; childThreadId?: string; message: string }): Promise<AgentTabContractRow> {
    if (!input.message.trim()) throw new Error('Message cannot be empty.');
    const selector = input.contractId
      ? ['id = $2', input.contractId]
      : ['child_thread_id = $2', input.childThreadId];
    const contract = await postgresClient.queryOne<AgentTabContractRow>(
      `SELECT * FROM agent_tab_contracts WHERE parent_thread_id = $1 AND ${ selector[0] } ORDER BY created_at DESC LIMIT 1`,
      [parentThreadId, selector[1]],
    );
    if (!contract) throw new Error('No matching child contract owned by this parent chat was found.');
    if (contract.status !== 'open') throw new Error(`Contract "${ contract.id }" is ${ contract.status }; it no longer accepts parent messages.`);
    await getWebSocketClientService().send(contract.parent_channel, {
      type: 'inject_message',
      data: {
        threadId: contract.child_thread_id,
        content: `[Message from parent agent]\n${ input.message }`,
        metadata: { source: 'agent_tab_parent_message', inputSource: 'system', contractId: contract.id },
      },
    });
    return contract;
  }

  list(parentThreadId: string, status?: AgentTabContractStatus): Promise<AgentTabContractRow[]> {
    return postgresClient.query<AgentTabContractRow>(`
      SELECT * FROM agent_tab_contracts
      WHERE parent_thread_id = $1 ${ status ? 'AND status = $2' : '' }
      ORDER BY created_at DESC
    `, status ? [parentThreadId, status] : [parentThreadId]);
  }
}

let instance: AgentTabContractService | undefined;
export function getAgentTabContractService(): AgentTabContractService {
  instance ??= new AgentTabContractService();
  return instance;
}
