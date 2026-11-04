// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Thin compatibility facade. All behavior belongs to constructor-injected classes under app/. */

import { skillDefinitionServiceProvider } from '../app/Providers/SkillDefinitionServiceProvider';
import { SKILL_SLUG_PATTERN, type ParsedSkill } from '../app/Services/Skills/SkillDefinitionCodec';
import {
  SKILL_FILE_MAX_BYTES,
  SKILL_MANIFEST,
  type SkillFolderSource,
} from '../app/Services/Skills/SkillFolderService';

import type { SkillImportSummary } from '../app/Services/Skills/SkillDefinitionApplicationService';

const facade = skillDefinitionServiceProvider.compatibility;

export { SKILL_FILE_MAX_BYTES, SKILL_MANIFEST, SKILL_SLUG_PATTERN };
export type { ParsedSkill, SkillFolderSource, SkillImportSummary };

export const splitSkillMarkdown = facade.split.bind(facade);
export const parseSkillMarkdown = facade.parse.bind(facade);
export const renderSkillMarkdown = facade.render.bind(facade);
export const hashSkillContent = facade.hash.bind(facade);
export const readSkillFolderFiles = facade.readFiles.bind(facade);
export const readSkillFolder = facade.readFolder.bind(facade);
export const scanSkillDir = facade.scan.bind(facade);
export const defaultSkillFolderSources = facade.defaultSources.bind(facade);
export const decideFolderImport = facade.decideImport.bind(facade);
export const importSkillFolders = facade.importFolders.bind(facade);
export const importSkillFolder = facade.importFolder.bind(facade);
export const exportSkillToDir = facade.exportToDir.bind(facade);
export const exportSkillToTempDir = facade.exportToTempDir.bind(facade);
export const resolveSkillCacheDir = facade.cacheDir.bind(facade);
export const materializeSkill = facade.materialize.bind(facade);
export const saveSkillFromMarkdown = facade.save.bind(facade);
