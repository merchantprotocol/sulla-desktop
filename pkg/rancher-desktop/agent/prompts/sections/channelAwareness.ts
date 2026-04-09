/**
 * Channel Awareness Section — Active agents and WebSocket channel info.
 * Priority: 100
 * Modes: full
 *
 * Dynamic section — changes every turn based on which agents are online.
 */
import type { PromptBuildContext, PromptSection } from '../SystemPromptBuilder';

export async function buildChannelAwarenessSection(ctx: PromptBuildContext): Promise<PromptSection | null> {
  if (ctx.mode !== 'full') return null;

  const wsChannel = ctx.wsChannel || 'sulla-desktop';

  let content: string;
  try {
    const { getActiveAgentsRegistry } = await import('../../services/ActiveAgentsRegistry');
    const registry = getActiveAgentsRegistry();
    const block = await registry.buildContextBlock();
    content = `${ block }\n\nYou run on the **${ wsChannel }** channel. Your \`sender_id\` and \`sender_channel\` are both \`${ wsChannel }\`.`;
  } catch {
    content = `## Inter-Agent Communication\n\nYou run on the **${ wsChannel }** channel.`;
  }

  return {
    id:             'channel_awareness',
    content,
    priority:       100,
    cacheStability: 'dynamic',
  };
}
