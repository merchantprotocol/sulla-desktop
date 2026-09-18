/** Read only a terminal receipt belonging to the exact workflow execution. */
export function workflowTerminalResult(metadata: Record<string, any>, executionId: string):
{ executionId: string; status: 'completed' | 'failed'; error?: string; outcome?: unknown } | null {
  const receipt = metadata.lastCompletedWorkflow;
  if (receipt?.executionId !== executionId || !['completed', 'failed'].includes(receipt.outcome)) return null;
  let outcome: unknown;
  for (const node of [...(receipt.nodeResults ?? [])].reverse()) {
    let result = node.result;
    if (typeof result === 'string') {
      try { result = JSON.parse(result.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
      catch { continue }
    }
    if (result && typeof result === 'object') { outcome = result; break }
  }
  return { executionId, status: receipt.outcome, error: receipt.error, outcome };
}
