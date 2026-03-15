// N8nProjectRelationModel.ts

import { BaseModel } from '../BaseModel';

interface N8nProjectRelationAttributes {
  projectId: string;
  userId:    string;
  role:      string;
  createdAt: Date;
  updatedAt: Date;
}

export class N8nProjectRelationModel extends BaseModel<N8nProjectRelationAttributes> {
  protected readonly tableName = 'project_relation';
  protected readonly primaryKey = ['projectId', 'userId']; // Composite primary key
  protected readonly timestamps = true;

  protected readonly fillable = [
    'projectId',
    'userId',
    'role',
  ];

  /**
   * Define casting rules for automatic type conversion
   */
  protected readonly casts: Record<string, string> = {
    createdAt: 'timestamp',
    updatedAt: 'timestamp',
  };

  /**
   * Create a project relation for a user
   */
  public static async createRelation(projectId: string, userId: string, role: string): Promise<N8nProjectRelationModel> {
    const relation = new N8nProjectRelationModel();
    relation.attributes.projectId = projectId;
    relation.attributes.userId = userId;
    relation.attributes.role = role;
    relation.attributes.createdAt = new Date();
    relation.attributes.updatedAt = new Date();
    await relation.save();
    return relation;
  }

  /**
   * Find existing relation
   */
  public static async findRelation(projectId: string, userId: string): Promise<N8nProjectRelationModel | null> {
    const relations = await N8nProjectRelationModel.whereRaw('projectId = ? AND userId = ?', [projectId, userId]);
    return relations.length > 0 ? relations[0] : null;
  }
}
