import { SelectBoxProvider, type SelectBoxContext, type SelectOption } from './SelectBoxProvider';

export class AlibabaModels extends SelectBoxProvider {
  readonly id = 'alibaba_models';

  async getOptions(_context: SelectBoxContext): Promise<SelectOption[]> {
    return [
      { value: 'qwen3.5-plus', label: 'Qwen 3.5 Plus', description: 'Latest Qwen, balanced performance' },
      { value: 'MiniMax-M2.5', label: 'MiniMax M2.5', description: '200K context, advanced reasoning' },
      { value: 'kimi-k2.5', label: 'Kimi K2.5', description: '256K context, long-context reasoning' },
      { value: 'glm-5', label: 'GLM 5', description: 'Zhipu GLM flagship model' },
      { value: 'qwen3-coder-plus', label: 'Qwen 3 Coder Plus', description: 'Optimized for code generation' },
      { value: 'qwen3-coder-next', label: 'Qwen 3 Coder Next', description: 'Next-gen code model' },
      { value: 'qwen3-max-2026-01-23', label: 'Qwen 3 Max', description: 'Most capable Qwen 3 model' },
      { value: 'glm-4.7', label: 'GLM 4.7', description: 'Zhipu GLM 4.7' },
    ];
  }
}
