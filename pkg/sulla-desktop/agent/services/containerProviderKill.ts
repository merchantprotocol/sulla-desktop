// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Shell run inside the agent container to signal one provider process and every
 * descendant it started (Bash run_in_background tasks, MCP helpers): argv is
 * `<pidFile> <TERM|KILL>`. The pidfile records `<pid> <starttime>`, so a reused
 * PID is never signalled.
 *
 * The process table is read once, then walked by a recursive function whose
 * body is a subshell. POSIX sh has no local variables: the previous version
 * shared `child`/`parent` across recursion levels, so after the first
 * descendant it signalled whichever PID the inner /proc scan had seen last.
 * That was often the container's `sleep infinity` keeper (PID 7), which ended
 * the `--rm` container ("no such object") whenever a provider with live
 * background tasks was stopped, or the next turn's freshly started CLI.
 * PID 1 (tini) is never signalled.
 *
 * Every PID's start time is snapshotted with the table and re-read from
 * /proc/<pid>/stat right before it is signalled; a PID that exited and was
 * reused in between is skipped. The start time is field 22 of stat, read
 * after the last `)` so a command name with spaces cannot shift it.
 */
export function buildContainerProviderKillScript(): string {
  return [
    'set -eu',
    'record=$(cat "$1" 2>/dev/null || true)',
    // eslint-disable-next-line no-template-curly-in-string
    'pid=${record%% *}',
    // eslint-disable-next-line no-template-curly-in-string
    'born=${record#* }',
    '[ -n "$pid" ] && [ "$pid" != "$record" ] || exit 0',
    'case "$pid" in ""|*[!0-9]*|1) exit 0;; esac',
    '[ -r "/proc/$pid/stat" ] || exit 0',
    // started <pid>: the process's start time (empty when it is gone).
    // eslint-disable-next-line no-template-curly-in-string
    'started() { s=$(cat "/proc/$1/stat" 2>/dev/null) || return 0; s=${s##*) }; printf "%s" "$s" | cut -d " " -f 20; }',
    '[ "$(started "$pid")" = "$born" ] || exit 0',
    'tree=$(for status in /proc/[0-9]*/status; do c=$(sed -n "s/^Pid:[[:space:]]*//p" "$status" 2>/dev/null || true); p=$(sed -n "s/^PPid:[[:space:]]*//p" "$status" 2>/dev/null || true); [ -z "$c" ] || [ -z "$p" ] || printf "%s %s %s\\n" "$c" "$p" "$(started "$c")"; done)',
    'descend() ( printf "%s\\n" "$tree" | while read -r c p t; do if [ "$p" = "$1" ] && [ "$c" != 1 ] && [ -n "$t" ]; then descend "$c" "$2" </dev/null; [ "$(started "$c")" != "$t" ] || kill -"$2" "$c" 2>/dev/null || true; fi; done )',
    'descend "$pid" "$2"',
    '[ "$(started "$pid")" != "$born" ] || kill -"$2" "$pid" 2>/dev/null || true',
    '[ "$2" != KILL ] || rm -f "$1"',
  ].join('; ');
}
