import { SelectBoxProvider, type SelectBoxContext, type SelectOption } from './SelectBoxProvider';

function normalizeBaseUrl(raw?: string): string {
  if (!raw?.trim()) {
    return 'http://127.0.0.1:11434';
  }

  return raw.trim().replace(/\/+$/, '');
}

interface OllamaTag {
  name: string;
}

interface OllamaTagsResponse {
  models?: OllamaTag[];
}

export class OllamaModels extends SelectBoxProvider {
  readonly id = 'ollama_models';

  async getOptions(context: SelectBoxContext): Promise<SelectOption[]> {
    const baseUrl = normalizeBaseUrl(context.formValues.base_url);

    try {
      const response = await fetch(`${ baseUrl }/api/tags`);

      if (!response.ok) {
        return this.getFallbackModels();
      }

      const body = await response.json() as OllamaTagsResponse;
      const names = (body.models ?? []).map(m => m.name).filter(Boolean);

      if (names.length > 0) {
        return names.map(name => ({ value: name, label: name }));
      }
    } catch {
      // Ollama may not be reachable yet; use static defaults
    }

    return this.getFallbackModels();
  }

  private getFallbackModels(): SelectOption[] {
    return [
      { value: 'llama3.2:latest', label: 'llama3.2:latest' },
      { value: 'qwen2.5:latest', label: 'qwen2.5:latest' },
      { value: 'mistral:latest', label: 'mistral:latest' },
    ];
  }
}

export class OllamaEmbedTextModels extends SelectBoxProvider {
  readonly id = 'ollama_embed_text_models';

  async getOptions(context: SelectBoxContext): Promise<SelectOption[]> {
    const baseUrl = normalizeBaseUrl(context.formValues.base_url);

    try {
      const response = await fetch(`${ baseUrl }/api/tags`);

      if (!response.ok) {
        return this.getFallbackModels();
      }

      const body = await response.json() as OllamaTagsResponse;
      const names = (body.models ?? []).map(m => m.name).filter(Boolean);
      const embedNames = names.filter(name => /embed|embedding|nomic|bge|mxbai/i.test(name));

      if (embedNames.length > 0) {
        return embedNames.map(name => ({ value: name, label: name }));
      }

      if (names.length > 0) {
        return names.map(name => ({ value: name, label: name }));
      }
    } catch {
      // Ollama may not be reachable yet; use static defaults
    }

    return this.getFallbackModels();
  }

  private getFallbackModels(): SelectOption[] {
    return [
      { value: 'nomic-embed-text:latest', label: 'nomic-embed-text:latest' },
      { value: 'mxbai-embed-large:latest', label: 'mxbai-embed-large:latest' },
      { value: 'bge-m3:latest', label: 'bge-m3:latest' },
    ];
  }
}
