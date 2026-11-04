// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { Connection } from '@sulla/foundation';

import { SkillDefinitionModel } from '../../database/models/SkillDefinitionModel';

import type {
  SkillDefinition,
  SkillDefinitionInput,
  SkillDefinitionPatch,
} from '../../database/models/SkillDefinitionModel';

export interface SkillRepositoryContract {
  findBySlug(slug: string): Promise<SkillDefinition | null>;
  create(input: SkillDefinitionInput): Promise<SkillDefinition>;
  update(id: string, patch: SkillDefinitionPatch): Promise<SkillDefinition | null>;
}

export class SkillRepository implements SkillRepositoryContract {
  constructor(private readonly connection: Connection) {}

  findBySlug(slug: string): Promise<SkillDefinition | null> {
    return SkillDefinitionModel.findBySlug(slug);
  }

  create(input: SkillDefinitionInput): Promise<SkillDefinition> {
    return SkillDefinitionModel.create(input);
  }

  update(id: string, patch: SkillDefinitionPatch): Promise<SkillDefinition | null> {
    return SkillDefinitionModel.update(id, patch);
  }
}
