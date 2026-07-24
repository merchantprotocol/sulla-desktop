import { SelectBoxProvider, type SelectBoxContext, type SelectOption } from './SelectBoxProvider';

const DEFAULT_BASE_URL = 'https://coding-intl.dashscope.aliyuncs.com/v1';

// Friendly labels/descriptions for known model ids. Unknown ids (e.g. models
// Alibaba adds later) still surface — they just show their raw id as the label.
const KNOWN: Record<string, { label: string; description?: string }> = {
  'qwen3.5-plus':         { label: 'Qwen 3.5 Plus', description: 'Balanced performance' },
  'qwen3.6-plus':         { label: 'Qwen 3.6 Plus', description: 'Newer Qwen generation' },
  'qwen3.7-plus':         { label: 'Qwen 3.7 Plus', description: 'Newest Qwen generation' },
  'qwen3-max-2026-01-23': { label: 'Qwen 3 Max', description: 'Most capable Qwen 3 model' },
  'qwen3-coder-plus':     { label: 'Qwen 3 Coder Plus', description: 'Optimized for code generation' },
  'qwen3-coder-next':     { label: 'Qwen 3 Coder Next', description: 'Next-gen code model' },
  'kimi-k2.5':            { label: 'Kimi K2.5', description: '256K context, long-context reasoning' },
  'glm-5':                { label: 'GLM 5', description: 'Zhipu GLM flagship model' },
  'glm-4.7':              { label: 'GLM 4.7', description: 'Zhipu GLM 4.7' },
  'MiniMax-M2.5':         { label: 'MiniMax M2.5', description: '200K context, advanced reasoning' },
};

export class AlibabaModels extends SelectBoxProvider {
  readonly id = 'alibaba_models';

  async getOptions(context: SelectBoxContext): Promise<SelectOption[]> {
    const apiKey  = context.formValues.api_key;
    const baseUrl = (context.formValues.base_url || DEFAULT_BASE_URL).replace(/\/$/, '');

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      // The DashScope Coding Plan /models route is readable without auth, but send the
      // key when we have it so the catalog reflects the account's entitlements.
      if (apiKey) {
        headers.Authorization = `Bearer ${ apiKey }`;
      }

      const response = await fetch(`${ baseUrl }/models`, {
        method:  'GET',
        headers,
        signal:  AbortSignal.timeout(10000),
      });

      if (response.ok) {
        const body = await response.json() as { data?: { id: string }[] };
        if (body.data && body.data.length > 0) {
          return body.data.map(m => this.toOption(m.id));
        }
      }
    } catch {
      // Fall back to static list
    }

    return this.getStaticModels();
  }

  private toOption(id: string): SelectOption {
    const known = KNOWN[id];
    return known
      ? { value: id, label: known.label, description: known.description }
      : { value: id, label: id };
  }

  // Last-resort fallback shown when the DashScope /models endpoint is unreachable.
  private getStaticModels(): SelectOption[] {
    return Object.keys(KNOWN).map(id => this.toOption(id));
  }
}
