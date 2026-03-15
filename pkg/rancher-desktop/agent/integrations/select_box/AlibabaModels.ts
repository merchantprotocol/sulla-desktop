import { SelectBoxProvider, type SelectBoxContext, type SelectOption } from './SelectBoxProvider';

export class AlibabaModels extends SelectBoxProvider {
  readonly id = 'alibaba_models';

  async getOptions(_context: SelectBoxContext): Promise<SelectOption[]> {
    return [
      { value: 'minimax-m2.5', label: 'MiniMax M2.5', description: '200K context, advanced reasoning' },
      { value: 'kimi-k2.5', label: 'Kimi K2.5', description: '256K context, long-context reasoning' },
      { value: 'qwen-plus', label: 'Qwen Plus', description: '128K context, balanced performance' },
      { value: 'qwen-max', label: 'Qwen Max', description: '128K context, most capable Qwen model' },
      { value: 'qwen-turbo', label: 'Qwen Turbo', description: '128K context, fast and affordable' },
    ];
  }
}
