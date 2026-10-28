// SPDX-License-Identifier: GPL-2.0-or-later
export async function handler(inputs) {
  const title = String(inputs.meeting_title || 'Meeting');
  const decisions = (inputs.decisions || []).map(String);
  const actions = (inputs.action_items || []).map((item) => {
    if (typeof item === 'string') return `- ${item}`;
    const due = item.due_date ? ` (due ${item.due_date})` : '';
    return `- ${item.owner || 'Owner'}: ${item.task || 'Follow up'}${due}`;
  });
  const lines = [`Hi,`, '', `Thanks for the ${title} today. Here’s a recap:`, ''];
  if (decisions.length) lines.push('Decisions:', ...decisions.map((item) => `- ${item}`), '');
  if (actions.length) lines.push('Action items:', ...actions, '');
  lines.push('Please reply with corrections or additions.');
  return { subject: `Follow-up: ${title}`, body: lines.join('\n'), recipients: inputs.attendees || [] };
}
