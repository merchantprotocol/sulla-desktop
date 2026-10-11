import { BaseTool, ToolResponse } from '../base';

/**
 * Directory of every callable agent in agent_definitions, as compact cards:
 * when to call it, when not to, what to send, what comes back, cost tier and
 * who it can call. Search with `query`, fetch one card with `slug`, or list
 * all. Call an agent with spawn_agent using its slug as agentId.
 */
export class AgentDirectoryWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { listAgentDirectory } = await import('../../services/AgentDirectoryService');
    const slug = typeof input?.slug === 'string' ? input.slug.trim() : '';
    const query = typeof input?.query === 'string' ? input.query.trim() : '';
    const includeInactive = input?.includeInactive === true;
    const limit = Number(input?.limit) > 0 ? Math.floor(Number(input.limit)) : undefined;

    let cards;
    try {
      cards = await listAgentDirectory({
        query:           slug ? undefined : query,
        slugs:           slug ? [slug] : undefined,
        includeInactive: includeInactive || !!slug,
        limit,
      });
    } catch (err) {
      return { successBoolean: false, responseString: `Could not read the agent directory: ${ (err as Error).message }` };
    }

    if (slug && cards.length === 0) {
      return { successBoolean: false, responseString: `No agent with slug "${ slug }". Run agents/directory without arguments to list every agent.` };
    }

    return {
      successBoolean: true,
      responseString: JSON.stringify({
        count:  cards.length,
        ...(query && !slug ? { query } : {}),
        agents: cards.map(card => ({
          slug:          card.slug,
          name:          card.name,
          whenToCall:    card.whenToCall,
          ...(card.whenNotToCall ? { whenNotToCall: card.whenNotToCall } : {}),
          ...(card.send ? { send: card.send } : {}),
          ...(card.returns ? { returns: card.returns } : {}),
          ...(card.costTier ? { costTier: card.costTier } : {}),
          ...(card.canCall.length ? { canCall: card.canCall } : {}),
          ...(card.model ? { model: card.model } : {}),
          ...(card.builtin ? { builtin: true } : {}),
          ...(!card.enabled || card.status === 'archive' ? { inactive: true, status: card.status, enabled: card.enabled } : {}),
        })),
        hint: cards.length
          ? 'Call one with spawn_agent: {"tasks":[{"agentId":"<slug>","prompt":"<self-contained brief with what the card says to send>"}]}.'
          : 'No agent matched. Run agents/directory without a query to list every agent.',
      }, null, 2),
    };
  }
}
