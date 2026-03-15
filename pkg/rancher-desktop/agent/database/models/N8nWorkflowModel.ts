import { BaseModel } from '../BaseModel';

interface N8nWorkflowAttributes {
  id:               string;
  name:             string;
  active:           boolean;
  nodes:            Record<string, any>[];
  connections:      Record<string, any>;
  createdAt:        Date;
  updatedAt:        Date;
  settings?:        Record<string, any> | null;
  staticData?:      Record<string, any> | null;
  pinData?:         Record<string, any> | null;
  versionId:        string;
  triggerCount:     number;
  meta?:            Record<string, any> | null;
  parentFolderId?:  string | null;
  isArchived:       boolean;
  versionCounter:   number;
  description?:     string | null;
  activeVersionId?: string | null;
}

export class N8nWorkflowModel extends BaseModel<N8nWorkflowAttributes> {
  protected readonly tableName = 'workflow_entity';
  protected readonly primaryKey = 'id';
  protected readonly timestamps = false;

  protected readonly fillable = [
    'id',
    'name',
    'active',
    'nodes',
    'connections',
    'createdAt',
    'updatedAt',
    'settings',
    'staticData',
    'pinData',
    'versionId',
    'triggerCount',
    'meta',
    'parentFolderId',
    'isArchived',
    'versionCounter',
    'description',
    'activeVersionId',
  ];

  protected readonly casts: Record<string, string> = {
    active:         'boolean',
    nodes:          'json',
    connections:    'json',
    createdAt:      'timestamp',
    updatedAt:      'timestamp',
    settings:       'json',
    staticData:     'json',
    pinData:        'json',
    triggerCount:   'integer',
    meta:           'json',
    isArchived:     'boolean',
    versionCounter: 'integer',
  };

  constructor(attributes: Partial<N8nWorkflowAttributes> = {}) {
    super();
    this.attributes = { ...attributes };
    this.original = { ...attributes };
  }
}
