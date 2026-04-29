import { SelectBoxProvider, type SelectBoxContext, type SelectOption } from './SelectBoxProvider';

export class AnthropicModels extends SelectBoxProvider {
  readonly id = 'anthropic_models';

  async getOptions(context: SelectBoxContext): Promise<SelectOption[]> {
    const apiKey = context.formValues.api_key;

    if (!apiKey) {
      return this.getStaticModels();
    }

    try {
      const response = await fetch('https://api.anthropic.com/v1/models', {
        headers: {
          'x-api-key':         apiKey,
          'anthropic-version': '2023-06-01',
        },
      });

      if (!response.ok) {
        return this.getStaticModels();
      }

      const body = await response.json() as { data?: { id: string; display_name?: string }[] };

      if (body.data && body.data.length > 0) {
        return body.data.map(m => ({ value: m.id, label: m.display_name || m.id }));
      }
    } catch {
      // Fall back to static list
    }

    return this.getStaticModels();
  }

  // Last-resort fallback shown when the Anthropic API is unreachable.
  // Model IDs here are aliases (no date suffix) so they self-update on Anthropic's side.
  private getStaticModels(): SelectOption[] {
    return [
      { value: 'claude-opus-4-7',   label: 'Claude Opus 4.7',   description: 'Most capable — orchestration and complex tasks' },
      { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', description: 'Latest balanced model' },
      { value: 'claude-haiku-4-5',  label: 'Claude Haiku 4.5',  description: 'Fast and lightweight — background agents' },
      { value: 'claude-3-7-sonnet-20250219', label: 'Claude 3.7 Sonnet', description: 'Extended thinking model' },
      { value: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku', description: 'Fast and lightweight (previous gen)' },
      { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet', description: 'Previous generation balanced' },
      { value: 'claude-3-opus-20240229', label: 'Claude 3 Opus', description: 'Most capable previous gen' },
    ];
  }
}
