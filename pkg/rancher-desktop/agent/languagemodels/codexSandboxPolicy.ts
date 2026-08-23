/** Codex CLI sandbox flags for normal actors versus read-only verifiers. */
export function codexSandboxArgs(readOnly: boolean): string[] {
  return readOnly
    ? ['--sandbox', 'read-only']
    : ['--dangerously-bypass-approvals-and-sandbox'];
}
