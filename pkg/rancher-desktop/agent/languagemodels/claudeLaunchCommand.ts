const shq = (s: string) => `'${ s.replace(/'/g, "'\\''") }'`;

/** VM-side pidfile for one spawn — lets an abort kill exactly that process. */
export function newRemotePidFile(prefix = 'sulla-claude'): string {
  return `/tmp/${ prefix }-${ Math.random().toString(36).slice(2) }${ Date.now().toString(36) }.pid`;
}

/** Record both pid and Linux process start time so a stale pidfile cannot kill a reused pid. */
export function buildRemotePidRecordCommand(pidFile: string): string {
  return `printf '%s %s\\n' "$$" "$(awk '{print $22}' /proc/$$/stat)" > ${ shq(pidFile) }`;
}

/**
 * Build a portable shell command for launching Claude inside Lima. When
 * `pidFile` is given, the shell records its PID there first; every `exec`
 * keeps that PID, so it ends up being the claude process itself.
 */
export function buildClaudeLaunchCommand(envAssignments: string[], claudeArgs: string[], pidFile?: string, exclusiveSession?: string): string {
  const envPrefix = envAssignments.length > 0 ? `${ envAssignments.join(' ') } ` : '';
  const command = claudeArgs.join(' ');
  const pidPrefix = pidFile ? `${ buildRemotePidRecordCommand(pidFile) }; ` : '';
  const lockPrefix = exclusiveSession ? buildSessionTakeoverCommand(exclusiveSession) : '';

  return `${ pidPrefix }${ lockPrefix }if command -v stdbuf >/dev/null 2>&1; then ${ envPrefix }exec stdbuf -oL -eL ${ command }; else ${ envPrefix }exec ${ command }; fi`;
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

  const waitForExit = sig === 'KILL'
    ? `i=0; while [ -d "/proc/$p" ] && [ "$i" -lt 40 ]; do sleep 0.05; i=$((i + 1)); done; [ ! -d "/proc/$p" ] || exit 4; `
    : '';

  return `read p started < ${ f } 2>/dev/null || exit 2; ` +
    `case "$p:$started" in *[!0-9:]*|:*) exit 2;; esac; ` +
    `current=$(awk '{print $22}' "/proc/$p/stat" 2>/dev/null || true); ` +
    `if [ -n "$current" ] && [ "$current" != "$started" ]; then rm -f ${ f }; exit 0; fi; ` +
    `if [ -n "$current" ]; then kill -${ sig } "$p" 2>/dev/null || exit 3; fi; ` +
    waitForExit +
    `${ sig === 'KILL' ? `rm -f ${ f }; ` : '' }` +
    `find ${ shq(dir) } -maxdepth 1 -name ${ shq(`${ base }-*.pid`) } -mmin +1440 -delete 2>/dev/null || true`;
}

/**
 * One live process per Claude session. Before a `--resume` launch, stop every
 * other `claude -p` process that holds the same session: either it was itself
 * resumed with that id, or its ~/.claude/sessions/<pid>.json records it (a
 * process that started the session fresh). Runs in the launching shell, which
 * becomes the new claude via exec, so `$$` is excluded. Only argv[0] `claude`
 * processes are matched — never the wrapping shells, whose command lines also
 * contain the session id.
 */
export function buildSessionTakeoverCommand(sessionId: string): string {
  const sid = sessionId.replace(/[^A-Za-z0-9_-]/g, '');
  if (!sid) return '';

  return `for p in $( { grep -l '"sessionId":"${ sid }"' "$HOME"/.claude/sessions/*.json 2>/dev/null | sed 's#.*/##; s#\\.json$##'; ` +
    `grep -l -- '${ sid }' /proc/[0-9]*/cmdline 2>/dev/null | cut -d/ -f3; } | sort -u ); do ` +
    `[ "$p" = "$$" ] && continue; ` +
    `tr '\\0' ' ' 2>/dev/null < /proc/$p/cmdline | grep -q '^claude -p ' && kill -TERM "$p" 2>/dev/null; ` +
    `done; `;
}
