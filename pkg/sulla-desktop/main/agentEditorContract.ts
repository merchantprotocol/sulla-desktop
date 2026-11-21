/*
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { cleanAgentModelTiers } from '../agent/languagemodels/agentModelTiers';

import type {
  AgentCostTier,
  AgentModelSlot,
} from '../agent/database/models/AgentDefinitionModel';
import type { ModelCandidate } from '../agent/languagemodels/modelRouter';
import type {
  AgentModelChoice,
  ModelClass,
} from '../agent/languagemodels/modelRoutingTypes';
import type {
  AgentEditorCreateInput,
  AgentEditorPatch,
} from '../shared/agentEditor';

const MAX_SHORT_TEXT = 10_000;
const MAX_PROMPT_TEXT = 200_000;
const MAX_LIST_ITEMS = 256;
const MODEL_EFFORT_PATTERN = /^[a-z][a-z0-9_-]{1,31}$/;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const MODEL_SLOTS = new Set<AgentModelSlot>([
  'primary',
  'secondary',
  'subconscious',
]);
const MODEL_CLASSES = new Set<ModelClass>([
  'frontier',
  'standard',
  'fast',
  'coding',
  'local',
]);
const COST_TIERS = new Set<AgentCostTier>(['low', 'medium', 'high']);

const CREATE_KEYS = new Set([
  'slug',
  'name',
  'description',
  'prompt',
  'provider',
  'runLocation',
  'modelSlot',
  'modelChoice',
  'modelFallbacks',
  'modelTiers',
  'enabled',
  'whenToCall',
  'whenNotToCall',
  'send',
  'returns',
  'costTier',
  'canCall',
  'frontDoor',
  'allowedTools',
  'skillRefs',
  'routineRefs',
]);

const PATCH_KEYS = new Set(
  [...CREATE_KEYS]
    .filter((key) => key !== 'slug' && key !== 'modelFallbacks' && key !== 'modelTiers')
    .concat('expectedUpdatedAt'),
);

export class AgentEditorValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentEditorValidationError';
  }
}

type RecordInput = Record<string, unknown>;

function isRecord(value: unknown): value is RecordInput {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, label: string): RecordInput {
  if (!isRecord(value)) { throw new AgentEditorValidationError(`${ label } must be an object.`) }
  return value;
}

function has(record: RecordInput, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function rejectUnknownKeys(
  record: RecordInput,
  allowed: Set<string>,
  label: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new AgentEditorValidationError(
        `${ label } contains unsupported field "${ key }".`,
      );
    }
  }
}

function readString(
  record: RecordInput,
  key: string,
  options: { required?: boolean; maxLength?: number; nonEmpty?: boolean } = {},
): string | undefined {
  if (!has(record, key)) {
    if (options.required) { throw new AgentEditorValidationError(`${ key } is required.`) }
    return undefined;
  }

  const value = record[key];
  if (typeof value !== 'string') { throw new AgentEditorValidationError(`${ key } must be a string.`) }
  if (options.nonEmpty && value.trim().length === 0) {
    throw new AgentEditorValidationError(`${ key } must not be empty.`);
  }
  if (value.length > (options.maxLength ?? MAX_SHORT_TEXT)) {
    throw new AgentEditorValidationError(`${ key } is too long.`);
  }
  return value;
}

function readBoolean(record: RecordInput, key: string): boolean | undefined {
  if (!has(record, key)) return undefined;
  if (typeof record[key] !== 'boolean') { throw new AgentEditorValidationError(`${ key } must be a boolean.`) }
  return record[key];
}

function readNullableBoolean(
  record: RecordInput,
  key: string,
): boolean | null | undefined {
  if (!has(record, key)) return undefined;
  if (record[key] !== null && typeof record[key] !== 'boolean') {
    throw new AgentEditorValidationError(`${ key } must be a boolean or null.`);
  }
  return record[key];
}

function readStringList(
  record: RecordInput,
  key: string,
): string[] | undefined {
  if (!has(record, key)) return undefined;
  const value = record[key];
  if (!Array.isArray(value)) { throw new AgentEditorValidationError(`${ key } must be an array.`) }
  if (value.length > MAX_LIST_ITEMS) { throw new AgentEditorValidationError(`${ key } has too many entries.`) }

  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new AgentEditorValidationError(
        `${ key } must contain non-empty strings.`,
      );
    }
    const normalized = item.trim();
    if (seen.has(normalized)) {
      throw new AgentEditorValidationError(
        `${ key } contains duplicate "${ normalized }".`,
      );
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function readCostTier(record: RecordInput): AgentCostTier | null | undefined {
  if (!has(record, 'costTier')) return undefined;
  const value = record.costTier;
  if (value === null) return null;
  if (typeof value !== 'string' || !COST_TIERS.has(value as AgentCostTier)) {
    throw new AgentEditorValidationError(
      'costTier must be low, medium, high, or null.',
    );
  }
  return value as AgentCostTier;
}

function readModelSlot(record: RecordInput): AgentModelSlot | undefined {
  if (!has(record, 'modelSlot')) return undefined;
  const value = record.modelSlot;
  if (typeof value !== 'string' || !MODEL_SLOTS.has(value as AgentModelSlot)) {
    throw new AgentEditorValidationError('modelSlot is invalid.');
  }
  return value as AgentModelSlot;
}

function readModelChoice(record: RecordInput): AgentModelChoice | undefined {
  if (!has(record, 'modelChoice')) return undefined;
  const value = asRecord(record.modelChoice, 'modelChoice');
  if (typeof value.mode !== 'string') { throw new AgentEditorValidationError('modelChoice.mode is required.') }

  if (value.mode === 'list') {
    rejectUnknownKeys(value, new Set(['mode']), 'modelChoice');
    return { mode: 'list' };
  }

  if (value.mode === 'class') {
    rejectUnknownKeys(value, new Set(['mode', 'class']), 'modelChoice');
    if (
      typeof value.class !== 'string' ||
      value.class.trim().length === 0 ||
      !MODEL_CLASSES.has(value.class.trim() as ModelClass)
    ) {
      throw new AgentEditorValidationError(
        'modelChoice.class must be a non-empty class.',
      );
    }
    return { mode: 'class', class: value.class.trim() as ModelClass };
  }

  if (value.mode !== 'pin') { throw new AgentEditorValidationError('modelChoice.mode is invalid.') }
  rejectUnknownKeys(
    value,
    new Set(['mode', 'provider', 'model', 'effort']),
    'modelChoice',
  );
  if (
    typeof value.provider !== 'string' ||
    value.provider.trim().length === 0
  ) {
    throw new AgentEditorValidationError(
      'modelChoice.provider must be a non-empty string.',
    );
  }
  if (typeof value.model !== 'string' || value.model.trim().length === 0) {
    throw new AgentEditorValidationError(
      'modelChoice.model must be a non-empty string.',
    );
  }
  if (
    value.effort !== undefined &&
    (typeof value.effort !== 'string' ||
      !MODEL_EFFORT_PATTERN.test(value.effort))
  ) {
    throw new AgentEditorValidationError('modelChoice.effort is invalid.');
  }
  return {
    mode:     'pin',
    provider: value.provider.trim(),
    model:    value.model.trim(),
    ...(value.effort === undefined ? {} : { effort: value.effort }),
  };
}

function readModelFallbacks(record: RecordInput): ModelCandidate[] | undefined {
  if (!has(record, 'modelFallbacks')) return undefined;
  const value = record.modelFallbacks;
  if (!Array.isArray(value)) {
    throw new AgentEditorValidationError('modelFallbacks must be an array.');
  }
  if (value.length > 9) {
    throw new AgentEditorValidationError('modelFallbacks has too many entries.');
  }

  const seen = new Set<string>();
  return value.map((item, index) => {
    const label = `modelFallbacks[${ index }]`;
    const candidate = asRecord(item, label);
    rejectUnknownKeys(candidate, new Set(['provider', 'model', 'effort']), label);
    const providerValue = readString(candidate, 'provider', {
      required:  true,
      nonEmpty:  true,
      maxLength: 256,
    })!;
    const modelValue = readString(candidate, 'model', {
      required:  true,
      nonEmpty:  true,
      maxLength: 256,
    })!;
    const provider = providerValue.trim();
    const model = modelValue.trim();
    const effort = readString(candidate, 'effort', {
      nonEmpty:  true,
      maxLength: 32,
    });
    if (effort !== undefined && !MODEL_EFFORT_PATTERN.test(effort)) {
      throw new AgentEditorValidationError(`${ label }.effort is invalid.`);
    }
    const key = JSON.stringify([provider, model, effort ?? null]);
    if (seen.has(key)) {
      throw new AgentEditorValidationError(`${ label } duplicates another fallback route.`);
    }
    seen.add(key);
    return {
      provider,
      model,
      ...(effort === undefined ? {} : { effort }),
    };
  });
}

function readExpectedUpdatedAt(record: RecordInput): string | undefined {
  if (!has(record, 'expectedUpdatedAt')) return undefined;
  const value = readString(record, 'expectedUpdatedAt', {
    nonEmpty:  true,
    maxLength: 128,
  });
  if (!value || Number.isNaN(Date.parse(value))) {
    throw new AgentEditorValidationError(
      'expectedUpdatedAt must be a valid timestamp.',
    );
  }
  return value;
}

function readCommonFields(
  record: RecordInput,
  required: boolean,
): AgentEditorPatch {
  const name = readString(record, 'name', { required, nonEmpty: required });
  const description = readString(record, 'description');
  const prompt = has(record, 'prompt')
    ? readString(record, 'prompt', { maxLength: MAX_PROMPT_TEXT })
    : undefined;
  const provider = readString(record, 'provider');
  const runLocation = readString(record, 'runLocation');
  if (
    runLocation !== undefined &&
    runLocation !== 'vm' &&
    runLocation !== 'container'
  ) {
    throw new AgentEditorValidationError('runLocation is invalid.');
  }
  const modelSlot = readModelSlot(record);
  const modelChoice = readModelChoice(record);
  const enabled = readBoolean(record, 'enabled');
  const whenToCall = readString(record, 'whenToCall', {
    maxLength: MAX_PROMPT_TEXT,
  });
  const whenNotToCall = readString(record, 'whenNotToCall', {
    maxLength: MAX_PROMPT_TEXT,
  });
  const send = readString(record, 'send', { maxLength: MAX_PROMPT_TEXT });
  const returns = readString(record, 'returns', { maxLength: MAX_PROMPT_TEXT });
  const costTier = readCostTier(record);
  const canCall = readStringList(record, 'canCall');
  const frontDoor = readNullableBoolean(record, 'frontDoor');
  const allowedTools = readStringList(record, 'allowedTools');
  const skillRefs = readStringList(record, 'skillRefs');
  const routineRefs = readStringList(record, 'routineRefs');

  return {
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(prompt === undefined ? {} : { prompt }),
    ...(provider === undefined ? {} : { provider }),
    ...(runLocation === undefined ? {} : { runLocation }),
    ...(modelSlot === undefined ? {} : { modelSlot }),
    ...(modelChoice === undefined ? {} : { modelChoice }),
    ...(enabled === undefined ? {} : { enabled }),
    ...(whenToCall === undefined ? {} : { whenToCall }),
    ...(whenNotToCall === undefined ? {} : { whenNotToCall }),
    ...(send === undefined ? {} : { send }),
    ...(returns === undefined ? {} : { returns }),
    ...(costTier === undefined ? {} : { costTier }),
    ...(canCall === undefined ? {} : { canCall }),
    ...(frontDoor === undefined ? {} : { frontDoor }),
    ...(allowedTools === undefined ? {} : { allowedTools }),
    ...(skillRefs === undefined ? {} : { skillRefs }),
    ...(routineRefs === undefined ? {} : { routineRefs }),
  };
}

export function validateAgentEditorCreateInput(
  input: unknown,
): AgentEditorCreateInput {
  const record = asRecord(input, 'Agent definition');
  rejectUnknownKeys(record, CREATE_KEYS, 'Agent definition');
  const slug = readString(record, 'slug', {
    required:  true,
    nonEmpty:  true,
    maxLength: 100,
  });
  if (!slug || !SLUG_PATTERN.test(slug)) {
    throw new AgentEditorValidationError(
      'slug must use lowercase letters, numbers, dots, underscores, or hyphens.',
    );
  }

  const common = readCommonFields(record, true);
  const modelFallbacks = readModelFallbacks(record) ?? [];
  let modelTiers;
  if (has(record, 'modelTiers')) {
    if (has(record, 'modelFallbacks') || common.modelChoice?.mode === 'pin') {
      throw new AgentEditorValidationError('modelTiers cannot be combined with modelFallbacks or a pinned modelChoice.');
    }
    try {
      modelTiers = cleanAgentModelTiers(record.modelTiers);
    } catch (cause) {
      throw new AgentEditorValidationError(`modelTiers: ${ cause instanceof Error ? cause.message : String(cause) }`);
    }
  }
  if (!common.name) throw new AgentEditorValidationError('name is required.');
  if (modelFallbacks.length && common.modelChoice?.mode !== 'pin') {
    throw new AgentEditorValidationError(
      'modelFallbacks require a pinned model choice.',
    );
  }
  if (common.modelChoice?.mode === 'pin') {
    const primaryKey = JSON.stringify([
      common.modelChoice.provider,
      common.modelChoice.model,
      common.modelChoice.effort ?? null,
    ]);
    if (modelFallbacks.some((candidate) => JSON.stringify([
      candidate.provider,
      candidate.model,
      candidate.effort ?? null,
    ]) === primaryKey)) {
      throw new AgentEditorValidationError(
        'modelFallbacks must not duplicate the primary model route.',
      );
    }
  }
  return {
    slug,
    name:        common.name,
    description: common.description ?? '',
    prompt:      common.prompt ?? '',
    modelSlot:   common.modelSlot ?? 'secondary',
    modelChoice: common.modelChoice ?? { mode: 'list' },
    modelFallbacks,
    ...(modelTiers ? { modelTiers } : {}),
    ...(common.provider === undefined ? {} : { provider: common.provider }),
    ...(common.runLocation === undefined
      ? {}
      : { runLocation: common.runLocation }),
    enabled:       common.enabled ?? true,
    whenToCall:    common.whenToCall ?? '',
    whenNotToCall: common.whenNotToCall ?? '',
    send:          common.send ?? '',
    returns:       common.returns ?? '',
    costTier:      common.costTier ?? null,
    canCall:       common.canCall ?? [],
    frontDoor:     common.frontDoor ?? null,
    allowedTools:  common.allowedTools ?? [],
    skillRefs:     common.skillRefs ?? [],
    routineRefs:   common.routineRefs ?? [],
  };
}

export function validateAgentEditorPatch(input: unknown): {
  patch:              AgentEditorPatch;
  expectedUpdatedAt?: string;
} {
  const record = asRecord(input, 'Agent definition update');
  rejectUnknownKeys(record, PATCH_KEYS, 'Agent definition update');
  const patch = readCommonFields(record, false);
  return {
    patch,
    expectedUpdatedAt: readExpectedUpdatedAt(record),
  };
}

export function validateAgentDefinitionId(id: unknown): string {
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new AgentEditorValidationError('Agent id is required.');
  }
  return id.trim();
}
