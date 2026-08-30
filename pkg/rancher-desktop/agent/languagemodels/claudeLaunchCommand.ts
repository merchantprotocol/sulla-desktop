/** Build a portable shell command for launching Claude inside Lima. */
export function buildClaudeLaunchCommand(envAssignments: string[], claudeArgs: string[]): string {
  const envPrefix = envAssignments.length > 0 ? `${ envAssignments.join(' ') } ` : '';
  const command = claudeArgs.join(' ');

  return `if command -v stdbuf >/dev/null 2>&1; then ${ envPrefix }exec stdbuf -oL -eL ${ command }; else ${ envPrefix }exec ${ command }; fi`;
}
