// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { MappedToolCardFormatter } from './MappedToolCardFormatter';
import { ToolCardText } from './ToolCardText';
export class ShellFileToolCardFormatter extends MappedToolCardFormatter {
  constructor(text: ToolCardText) {
    super({
  exec:         (args, result) => ({ label: 'Bash', summary: text.string(args.command || args.cmd) ? text.truncate(text.string(args.command || args.cmd), 70) : 'Running command', input: text.string(args.command || args.cmd) || undefined, output: text.extractOutput(result), outputFormat: 'code' }),
  exec_command: (args, result) => ({ label: 'Bash', summary: text.string(args.command || args.cmd) ? text.truncate(text.string(args.command || args.cmd), 70) : 'Running command', input: text.string(args.command || args.cmd) || undefined, output: text.extractOutput(result), outputFormat: 'code' }),
  shell:        (args, result) => ({ label: 'Bash', summary: text.string(args.command || args.cmd) ? text.truncate(text.string(args.command || args.cmd), 70) : 'Running command', input: text.string(args.command || args.cmd) || undefined, output: text.extractOutput(result), outputFormat: 'code' }),
  bash:         (args, result) => ({ label: 'Bash', summary: text.string(args.command || args.cmd) ? text.truncate(text.string(args.command || args.cmd), 70) : 'Running command', input: text.string(args.command || args.cmd) || undefined, output: text.extractOutput(result), outputFormat: 'code' }),
  run_command:  (args, result) => ({ label: 'Bash', summary: text.string(args.command || args.cmd) ? text.truncate(text.string(args.command || args.cmd), 70) : 'Running command', input: text.string(args.command || args.cmd) || undefined, output: text.extractOutput(result), outputFormat: 'code' }),

  // Host machine exec (macOS login shell — not the Sulla VM)
  exechost:     (args, result) => { const cmd = text.string(args.command || args.cmd); const cwd = text.shortenHome(text.string(args.cwd)); const where = cwd ? ` in ${ text.truncate(cwd, 40) }` : ''; return { label: 'Host', summary: cmd ? `Host: ${ text.truncate(cmd, 60) }${ where }` : 'Running on host', input: cmd || undefined, output: text.extractOutput(result), outputFormat: 'code' }; },

  file_search(args) {
    const query = text.string(args.query);
    const dirPath = text.string(args.dirPath) || '~';
    const shortDir = dirPath.replace(/^\/Users\/[^/]+/, '~');
    return {
      label:   'Search',
      summary: `Searching for "${ text.truncate(query, 60) }" in ${ shortDir }`,
    };
  },

  read_file(args) {
    const filePath = text.string(args.path || args.filePath);
    const shortPath = filePath.replace(/^\/Users\/[^/]+/, '~');
    const startLine = args.startLine as number | undefined;
    const endLine = args.endLine as number | undefined;
    const range = startLine ? ` (lines ${ startLine }${ endLine ? `-${ endLine }` : '+' })` : '';
    return {
      label:   'File',
      summary: `Opening ${ text.truncate(shortPath, 60) }${ range }`,
    };
  },
    });
  }
}
