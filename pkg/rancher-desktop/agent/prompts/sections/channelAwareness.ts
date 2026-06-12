/**
 * Channel Awareness Section — Inter-agent messaging protocol.
 * Priority: 100
 * Modes: full
 *
 * Stable section — only the static messaging instructions live here. The
 * live roster (agent statuses, human presence) changes every turn, so it
 * travels in the per-turn <turn_context> block instead (see
 * prompts/turnContext.ts) and never churns the cached system-prompt prefix.
 */
import type { PromptBuildContext, PromptSection } from '../SystemPromptBuilder';

export function buildChannelAwarenessSection(ctx: PromptBuildContext): PromptSection | null {
  if (ctx.mode !== 'full') return null;

  const wsChannel = ctx.wsChannel || 'sulla-desktop';

  const content = [
    `## Inter-Agent Communication`,
    ``,
    `You are part of an agent network. The live roster of active agents (and the human's presence) arrives in the <turn_context> block of the latest message each turn.`,
    ``,
    `You run on the **${ wsChannel }** channel. Your \`sender_id\` and \`sender_channel\` are both \`${ wsChannel }\`.`,
    ``,
    `**To message another agent**, wrap your message in XML tags named after the target channel:`,
    `\`\`\``,
    `<channel:heartbeat>Are you online?</channel:heartbeat>`,
    `<channel:workbook>Please update the status for task #42.</channel:workbook>`,
    `\`\`\``,
    `The system automatically detects these tags and routes the message. No tool call needed.`,
    ``,
    `**Rules:**`,
    `- Channel messages are **fire-and-forget**. After sending, continue your work normally.`,
    `- Do NOT poll or search for a reply. If the receiving agent responds, their reply arrives on your channel automatically.`,
    `- If no reply comes, the agent either hasn't responded yet or chose not to. Try again or move on.`,
  ].join('\n');

  return {
    id:             'channel_awareness',
    content,
    priority:       100,
    cacheStability: 'stable',
  };
}
