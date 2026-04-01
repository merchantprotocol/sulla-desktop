import { SelectBoxProvider, type SelectBoxContext, type SelectOption } from './SelectBoxProvider';

/**
 * Provides the AI access level options for vault credentials.
 * Controls what the language model can see and do with each credential.
 */
export class VaultLlmAccess extends SelectBoxProvider {
  readonly id = 'vault_llm_access';

  async getOptions(_context: SelectBoxContext): Promise<SelectOption[]> {
    return [
      {
        value:       'none',
        label:       'None',
        description: 'AI cannot see or use this credential',
      },
      {
        value:       'metadata',
        label:       'Metadata only',
        description: 'AI can see the account name but not passwords or secrets',
      },
      {
        value:       'autofill',
        label:       'Autofill',
        description: 'AI can use credentials for login forms and tool integrations but never sees passwords directly',
      },
      {
        value:       'full',
        label:       'Full access',
        description: 'AI can read and use all credential values',
      },
    ];
  }
}
