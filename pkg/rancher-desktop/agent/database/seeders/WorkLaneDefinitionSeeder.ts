import { WorkLaneDefinitionModel } from '../models/WorkLaneDefinitionModel';

export async function initialize(): Promise<void> {
  await WorkLaneDefinitionModel.ensureTable();
  const result = await WorkLaneDefinitionModel.seedDefaultsAndLegacyStatuses();
  console.log(`[WorkLaneDefinitionSeeder] Seeded ${ result.defaults } default and ${ result.legacy } legacy lane definition(s)`);
}
