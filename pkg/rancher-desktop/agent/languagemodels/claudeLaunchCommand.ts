const shq = (s: string) => `'${ s.replace(/'/g, "'\\''") }'`;

/** VM-side pidfile for one spawn — lets an abort kill exactly that process. */
export function newRemotePidFile(prefix = 'sulla-claude'): string {
  return `/tmp/${ prefix }-${ Math.random().toString(36).slice(2) }${ Date.now().toString(36) }.pid`;
}

/**
 * Build a portable shell command for launching Claude inside Lima. When
 * `pidFile` is given, the shell records its PID there first; every `exec`
 * keeps that PID, so it ends up being the claude process itself.
 */
export function buildClaudeLaunchCommand(envAssignments: string[], claudeArgs: string[], pidFile?: string): string {
  const envPrefix = envAssignments.length > 0 ? `${ envAssignments.join(' ') } ` : '';
  const command = claudeArgs.join(' ');
  const pidPrefix = pidFile ? `echo $$ > ${ shq(pidFile) }; ` : '';

  return `${ pidPrefix }if command -v stdbuf >/dev/null 2>&1; then ${ envPrefix }exec stdbuf -oL -eL ${ command }; else ${ envPrefix }exec ${ command }; fi`;
}

/**
 * Signal ONLY the process recorded in `pidFile`. A VM-wide `pkill -f` would
 * also kill every other concurrent CLI run — other agents, and the run the
 * user's steering message just started — which then surface as
 * "returned no output". Also sweeps pidfiles older than a day.
 */
export function buildRemoteKillCommand(pidFile: string, sig: 'TERM' | 'KILL'): string {
  const f = shq(pidFile);
  const dir = pidFile.slice(0, pidFile.lastIndexOf('/')) || '/';
  const base = pidFile.slice(pidFile.lastIndexOf('/') + 1).replace(/-[^-]*\.pid$/, '');

  return `p=$(cat ${ f } 2>/dev/null); [ -n "$p" ] && kill -${ sig } "$p" 2>/dev/null; `
    + `${ sig === 'KILL' ? `rm -f ${ f }; ` : '' }`
    + `find ${ shq(dir) } -maxdepth 1 -name ${ shq(`${ base }-*.pid`) } -mmin +1440 -delete 2>/dev/null; true`;
}
