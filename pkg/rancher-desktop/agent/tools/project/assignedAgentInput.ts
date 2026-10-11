/**
 * Read the project-level assigned agent from tool input. `assignedAgent` is the
 * documented name; `assigned_agent` is accepted so snake_case callers work too.
 * Returns undefined when absent (leave unchanged) and null for an empty string
 * (clear the assignment).
 */
export function assignedAgentInput(input: Record<string, unknown>): string | null | undefined {
  const raw = input.assignedAgent !== undefined ? input.assignedAgent : input.assigned_agent;
  if (raw === undefined || raw === null) return raw;
  if (typeof raw !== 'string') throw new Error('assignedAgent must be an agent slug string.');
  const slug = raw.trim();
  return slug || null;
}
