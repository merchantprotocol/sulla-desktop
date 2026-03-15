// N8nProjectModel.ts

import crypto from 'crypto';
import { BaseModel } from '../BaseModel';

interface N8nProjectAttributes {
  id:           string;
  name:         string;
  type:         string;
  createdAt:    Date;
  updatedAt:    Date;
  icon?:        any;
  description?: string;
  creatorId?:   string;
}

export class N8nProjectModel extends BaseModel<N8nProjectAttributes> {
  protected readonly tableName = 'project';
  protected readonly primaryKey = 'id';
  protected readonly timestamps = true;

  protected readonly fillable = [
    'name',
    'type',
    'icon',
    'description',
    'creatorId',
  ];

  /**
   * Define casting rules for automatic type conversion
   */
  protected readonly casts: Record<string, string> = {
    createdAt: 'timestamp',
    updatedAt: 'timestamp',
    icon:      'json',
  };

  /**
   * Find or create a project by name
   */
  public static async findOrCreate(name: string, type = 'personal', creatorId?: string): Promise<N8nProjectModel> {
    let project = await N8nProjectModel.where('name', name).first();

    if (!project) {
      project = new N8nProjectModel();
      project.attributes.id = crypto.randomUUID();
      project.attributes.name = name;
      project.attributes.type = type;
      project.attributes.createdAt = new Date();
      project.attributes.updatedAt = new Date();
      if (creatorId) {
        project.attributes.creatorId = creatorId;
      }
      await project.save();
    }

    return project;
  }
}
