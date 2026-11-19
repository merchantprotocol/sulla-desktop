// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

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
  const mobileRule = wsChannel === 'mobile-relay'
    ? `On mobile-relay, Jonathon may be driving: talk like a spoken conversation in plain sentences and lead with the answer or what moved. Keep simple replies short, but give the full context a question needs, and whenever he asks for more detail or repeats a question, explain it completely; never cap yourself at a sentence count. Omit lists, headings, HTML, code, citations and URLs unless asked.`
    : '';

  const content = [
    `## Inter-Agent Communication`,
    ``,
    `You are part of an agent network. The live roster of active agents (and the human's presence) arrives in the <turn_context> block of the latest message each turn.`,
    ``,
    `You run on the **${ wsChannel }** channel. Your \`sender_id\` and \`sender_channel\` are both \`${ wsChannel }\`. The live roster lists each instance's label and addressable thread/job id.`,
    mobileRule,
    ``,
    `**To message another agent**, wrap your message in XML tags named after the target channel:`,
    `\`\`\``,
    `<channel:heartbeat>Are you online?</channel:heartbeat>`,
    `<channel:mobile-relay>Your requested update is ready.</channel:mobile-relay>`,
    `<channel:coding-manager#<threadId-or-jobId>>Send this to that exact manager instance.</channel:coding-manager#<threadId-or-jobId>>`,
    `\`\`\``,
    `The system automatically detects these tags and routes the message. No tool call needed.`,
    `Use the \`#threadId-or-jobId\` suffix whenever a channel has multiple instances. Bare channel names are accepted only when exactly one instance matches; ambiguous messages are not delivered and return candidate addresses. To reply to a peer, use its sender thread/job id from the message provenance (or the matching roster address) in the same \`#id\` form.`,
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
