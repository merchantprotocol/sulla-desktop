// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { DesktopPostgresConnection } from '../Database/DesktopPostgresConnection';
import { SkillRepository } from '../Repositories/SkillRepository';
import { SkillDefinitionApplicationService } from '../Services/Skills/SkillDefinitionApplicationService';
import { SkillDefinitionCompatibilityFacade } from '../Services/Skills/SkillDefinitionCompatibilityFacade';
import { SkillFolderService } from '../Services/Skills/SkillFolderService';
import { postgresClient } from '../../database/PostgresClient';
import { resolveSullaHomeDir, resolveSullaSkillsDir, resolveSullaUserSkillsDir } from '../../utils/sullaPaths';

export class SkillDefinitionServiceProvider {
  readonly folders: SkillFolderService;
  readonly skills: SkillDefinitionApplicationService;
  readonly compatibility: SkillDefinitionCompatibilityFacade;

  constructor() {
    this.folders = new SkillFolderService();
    this.skills = new SkillDefinitionApplicationService(
      new SkillRepository(new DesktopPostgresConnection(postgresClient)),
      this.folders,
      {
        home: resolveSullaHomeDir,
        userSkills: resolveSullaUserSkillsDir,
        resourceSkills: resolveSullaSkillsDir,
      },
    );
    this.compatibility = new SkillDefinitionCompatibilityFacade(this.skills, this.folders);
  }
}

export const skillDefinitionServiceProvider = new SkillDefinitionServiceProvider();
