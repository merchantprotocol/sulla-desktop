import { BaseModel } from '../BaseModel';

interface N8nSettingsAttributes {
  key:           string;
  value:         string;
  loadOnStartup: boolean;
}

export class N8nSettingsModel extends BaseModel<N8nSettingsAttributes> {
  protected readonly tableName = 'settings';
  protected readonly primaryKey = 'key';
  protected readonly timestamps = false;

  protected readonly fillable = [
    'key',
    'value',
    'loadOnStartup',
  ];

  protected readonly casts: Record<string, string> = {
    value:         'string',
    loadOnStartup: 'boolean',
  };

  constructor(attributes: Partial<N8nSettingsAttributes> = {}) {
    super();
    this.attributes = { ...attributes };
    this.original = { ...attributes };
  }
}
