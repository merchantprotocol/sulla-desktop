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
 *
 * Each pass also records the descendants it signalled in `<pidFile>.desc`.
 * A child that ignores TERM is reparented to PID 1 once the provider exits,
 * so the KILL pass could no longer find it by walking the tree; it signals the
 * recorded ones too (start time rechecked), then removes both files.
 *
 * The KILL pass waits up to 2 s for the provider to exit and exits 4 if it is
 * still alive, so a caller that needs confirmation can fail closed.
 */
export function buildContainerProviderKillScript(): string {
  return [
    'set -eu',
    // started <pid>: the process's start time (empty when it is gone).
    // eslint-disable-next-line no-template-curly-in-string
    'started() { s=$(cat "/proc/$1/stat" 2>/dev/null) || return 0; s=${s##*) }; printf "%s" "$s" | cut -d " " -f 20; }',
    // alive <pid> <starttime>: the same process still exists and is not a zombie.
    // eslint-disable-next-line no-template-curly-in-string
    'alive() { s=$(cat "/proc/$1/stat" 2>/dev/null) || return 1; s=${s##*) }; case "$s" in Z*) return 1;; esac; [ "$(printf "%s" "$s" | cut -d " " -f 20)" = "$2" ]; }',
    'descend() ( printf "%s\\n" "$tree" | while read -r c p t; do if [ "$p" = "$1" ] && [ "$c" != 1 ] && [ -n "$t" ]; then descend "$c" "$2" </dev/null; printf "%s %s\\n" "$c" "$t"; [ "$(started "$c")" != "$t" ] || kill -"$2" "$c" 2>/dev/null || true; fi; done )',
    'pid=; born=',
    // eslint-disable-next-line no-template-curly-in-string
    'main() { record=$(cat "$1" 2>/dev/null || true); r=${record%% *}; b=${record#* }; [ -n "$r" ] && [ "$r" != "$record" ] || return 0; case "$r" in *[!0-9]*|1) return 0;; esac; [ "$(started "$r")" = "$b" ] || return 0; pid=$r; born=$b; tree=$(for status in /proc/[0-9]*/status; do c=$(sed -n "s/^Pid:[[:space:]]*//p" "$status" 2>/dev/null || true); p=$(sed -n "s/^PPid:[[:space:]]*//p" "$status" 2>/dev/null || true); [ -z "$c" ] || [ -z "$p" ] || printf "%s %s %s\\n" "$c" "$p" "$(started "$c")"; done); if touch "$1.desc" 2>/dev/null && [ -w "$1.desc" ]; then descend "$pid" "$2" >> "$1.desc"; else descend "$pid" "$2" >/dev/null; fi; [ "$(started "$pid")" != "$born" ] || kill -"$2" "$pid" 2>/dev/null || true; }',
    'main "$1" "$2"',
    '[ "$2" = KILL ] || exit 0',
    'if [ -r "$1.desc" ]; then while read -r c t; do case "$c" in ""|*[!0-9]*|1) continue;; esac; [ -z "$t" ] || [ "$(started "$c")" != "$t" ] || kill -KILL "$c" 2>/dev/null || true; done < "$1.desc"; fi',
    'rm -f "$1.desc" "$1"',
    '[ -n "$pid" ] || exit 0',
    'i=0; while alive "$pid" "$born" && [ "$i" -lt 40 ]; do sleep 0.05; i=$((i + 1)); done',
    '! alive "$pid" "$born" || exit 4',
  ].join('; ');
}
