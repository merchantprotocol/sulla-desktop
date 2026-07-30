import { BaseTool, ToolResponse } from '../base';

/**
 * Directory of the live named agents you can message. Returns each running
 * agent with its channel, status, and uptime — the same roster that appears in
 * turn context, but queryable on demand (e.g. before addressing one).
 *
 * To message any of these, emit a channel tag in your reply:
 *   <channel:heartbeat>your message</channel:heartbeat>
 * Channel messages are fire-and-forget; the agent's reply arrives on your
 * channel on a later turn (it is not a synchronous request/response). For a
 * synchronous back-and-forth with a fresh delegated sub-agent, use
 * start_agent_conversation / send_agent_message instead.
 */
export class ListAgentsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(_input: any): Promise<ToolResponse> {
    let agents: any[] = [];
    try {
      const { getActiveAgentsRegistry } = await import('../../services/ActiveAgentsRegistry');
      agents = await getActiveAgentsRegistry().getAllAgents();
    } catch (err) {
      return {
        successBoolean: false,
        responseString: `Could not read the active-agents registry: ${ (err as Error).message }`,
      };
    }

    const now = Date.now();
    const rows = agents
      .filter(a => a.type !== 'human')
      .map(a => ({
        name:        a.name || a.agentId,
        channel:     a.channel,
        status:      a.status,
        uptimeMins:  Math.floor((now - a.startedAt) / 60000),
        idleMins:    Math.floor((now - a.lastActiveAt) / 60000),
        description: a.description,
        statusNote:  a.statusNote && a.statusNote !== 'idle' ? a.statusNote : undefined,
      }));

    if (rows.length === 0) {
      return {
        successBoolean: true,
        responseString: 'No named agents are currently registered as running.',
      };
    }

    return {
      successBoolean: true,
      responseString: JSON.stringify({
        count:  rows.length,
        agents: rows,
        hint:   'Message any of these with <channel:CHANNEL>text</channel:CHANNEL> (fire-and-forget; reply arrives on a later turn).',
      }, null, 2),
    };
  }
}
