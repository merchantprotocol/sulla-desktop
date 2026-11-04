// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { MappedToolCardFormatter } from './MappedToolCardFormatter';
import { ToolCardText } from './ToolCardText';
export class PlatformToolCardFormatter extends MappedToolCardFormatter {
  constructor(text: ToolCardText) {
    super({
  create_skill(args) {
    return { label: 'Skills', summary: `Creating skill: ${ text.string(args.skill_name) }` };
  },

  integration_list() {
    return { label: 'Integrations', summary: 'Listing integrations' };
  },
  vault_is_enabled(args) {
    return { label: 'Vault', summary: `Checking ${ text.string(args.account_type) }` };
  },
  vault_read_secrets(args) {
    return { label: 'Vault', summary: `Reading credentials for ${ text.string(args.account_type) }` };
  },
  vault_list_accounts(args) {
    return { label: 'Vault', summary: `Listing accounts for ${ text.string(args.account_type) }` };
  },
  vault_set_active_account(args) {
    return { label: 'Vault', summary: `Setting active account for ${ text.string(args.account_type) }` };
  },
  vault_set_credential(args) {
    return { label: 'Vault', summary: `Saving credential for ${ text.string(args.account_type) }` };
  },
  vault_create_password(args) {
    return { label: 'Vault', summary: `Saving password for ${ text.string(args.title) }` };
  },
  vault_generate_password(args) {
    return { label: 'Vault', summary: `Generating password for ${ text.string(args.title) }` };
  },
  vault_update_password() {
    return { label: 'Vault', summary: 'Rotating vault password' };
  },


    });
  }
}
