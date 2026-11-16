// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { CoherentBackupService } from './backup/CoherentBackupService.js';
import { CoherentRestoreService } from './backup/CoherentRestoreService.js';
import { NightlyBackupSchedule } from './backup/NightlyBackupSchedule.js';

import type { Config } from './config.js';

/** The `backup` / `restore` CLI commands, composed from the coherent backup services. */
export class CoherentBackupCommands {
  constructor(
    private readonly config:Config,
    private readonly backups = new CoherentBackupService(),
    private readonly restores = new CoherentRestoreService(),
  ) {}

  backup():Promise<string> { return this.backups.backup(this.config) }

  restore(archive?:string):Promise<string> { return this.restores.restore(this.config, archive) }

  nightly():Promise<never> { return new NightlyBackupSchedule(() => this.backup()).forever() }
}

// Entry points index.ts calls; they compose fresh services per command.
export function backup(config:Config):Promise<string> { return new CoherentBackupCommands(config).backup() }
export function restore(config:Config, archive?:string):Promise<string> { return new CoherentBackupCommands(config).restore(archive) }
export function nightlyBackups(config:Config):Promise<never> { return new CoherentBackupCommands(config).nightly() }
