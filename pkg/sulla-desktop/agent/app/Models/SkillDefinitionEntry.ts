// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { Model } from '@sulla/foundation';

export class SkillDefinitionEntry extends Model<Record<string, unknown>> {
  static table = 'skill_definitions';
}
