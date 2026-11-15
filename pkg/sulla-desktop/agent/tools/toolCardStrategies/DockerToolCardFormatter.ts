// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { MappedToolCardFormatter } from './MappedToolCardFormatter';
import { ToolCardText } from './ToolCardText';
export class DockerToolCardFormatter extends MappedToolCardFormatter {
  constructor(text: ToolCardText) {
    super({
  docker_build(args) {
    return { label: 'Docker', summary: `Building image${ args.tag ? ` ${ text.string(args.tag) }` : '' }` };
  },
  docker_run(args) {
    const name = text.string(args.name);
    const image = text.string(args.image);
    return { label: 'Docker', summary: `Running ${ name || image }`, input: text.string(args.command) || undefined };
  },
  docker_exec(args) {
    return { label: 'Docker', summary: `Executing in ${ text.string(args.container) }`, input: text.string(args.command) || undefined };
  },
  docker_ps(args) {
    return { label: 'Docker', summary: `Listing ${ args.all ? 'all ' : '' }containers` };
  },
  docker_logs(args) {
    const tail = args.tail ? ` (last ${ args.tail })` : '';
    return { label: 'Docker', summary: `Reading logs from ${ text.string(args.container) }${ tail }` };
  },
  docker_pull(args) {
    return { label: 'Docker', summary: `Pulling ${ text.truncate(text.string(args.image), 50) }` };
  },
  docker_stop(args) {
    return { label: 'Docker', summary: `Stopping ${ text.string(args.container) }` };
  },
  docker_rm(args) {
    return { label: 'Docker', summary: `Removing ${ text.string(args.container) }` };
  },
  docker_images(args) {
    return { label: 'Docker', summary: `Listing ${ args.all ? 'all ' : '' }images` };
  },
  docker_stats(args) { return { label: 'Docker', summary: 'Reading container resource statistics' }; },
  docker_inspect_health(args) { return { label: 'Docker', summary: 'Inspecting container health' }; },
  docker_system_df(args) { return { label: 'Docker', summary: 'Reading Docker disk usage' }; },
  docker_vm_snapshot(args) { return { label: 'Docker', summary: 'Reading VM resource snapshot' }; },
    });
  }
}
