// src/tools/base.ts
import { ToolResult } from '../types';

export type ToolOperation = 'read' | 'create' | 'update' | 'delete' | 'execute';

export interface ToolMetadata extends Record<string, unknown> {
  category:          string;
  requiresApproval?: boolean;
  isReadOnly?:       boolean;
  operationTypes?:   ToolOperation[];
}

type FieldType = 'string' | 'number' | 'boolean' | 'enum' | 'array' | 'object';

interface FieldSchema {
  type:         FieldType;
  enum?:        string[];
  items?:       FieldSchema;
  properties?:  Record<string, FieldSchema>;
  description?: string;
  default?:     unknown;
  optional?:    boolean;
  nullable?:    boolean;
}

type InputSchemaDef = Record<string, FieldSchema>;

type ParsedInput = Record<string, unknown>;

export interface ToolResponse {
  successBoolean: boolean;
  responseString: string;
}

export interface ToolRegistration {
  name:            string;
  description:     string;
  category:        string;
  schemaDef?:      InputSchemaDef;
  workerClass:     new () => BaseTool;
  operationTypes?: ToolOperation[];
}

export abstract class BaseTool<TState = any> {
  abstract name: string;
  abstract description: string;
  schemaDef: InputSchemaDef = {};

  metadata: ToolMetadata = { category: 'general' };

  // ─────────────────────────────────────────────────────────────
  // Runtime validation + JSON schema generation
  // ─────────────────────────────────────────────────────────────

  protected parseInput(raw: unknown): ParsedInput {
    const result: ParsedInput = {};
    const errors: string[] = [];
    let source: any = raw;

    if (typeof source === 'string') {
      try {
        source = JSON.parse(source);
      } catch {
        source = { raw: source };
      }
    }

    if (source && typeof source === 'object' && !Array.isArray(source)) {
      const nestedInput = source.input;
      if (nestedInput && typeof nestedInput === 'object' && !Array.isArray(nestedInput)) {
        const topLevelHasSchemaFields = Object.keys(this.schemaDef).some((key) => source[key] !== undefined);
        const nestedHasSchemaFields = Object.keys(this.schemaDef).some((key) => nestedInput[key] !== undefined);
        if (!topLevelHasSchemaFields && nestedHasSchemaFields) {
          source = nestedInput;
        }
      }
    }

    for (const [key, spec] of Object.entries(this.schemaDef)) {
      const value = source?.[key];

      if (value === undefined || value === null) {
        if (!spec.optional) errors.push(`Missing required field: ${ key }`);
        if (spec.default !== undefined) result[key] = spec.default;
        continue;
      }

      switch (spec.type) {
      case 'string':
        if (typeof value !== 'string') errors.push(`Invalid type for ${ key }: expected string`);
        result[key] = String(value);
        break;
      case 'number':
        const num = Number(value);
        if (isNaN(num)) errors.push(`Invalid number for ${ key }`);
        result[key] = num;
        break;
      case 'boolean':
        result[key] = !!value;
        break;
      case 'enum':
        if (!spec.enum?.includes(value as string)) {
          errors.push(`Invalid value for ${ key }: must be one of ${ spec.enum?.join(', ') }`);
        }
        result[key] = value;
        break;
      case 'array':
        {
          let parsedArray: unknown = value;
          if (typeof value === 'string') {
            try {
              parsedArray = JSON.parse(value);
            } catch {
              errors.push(`Invalid JSON array for ${ key }`);
            }
          }
          if (!Array.isArray(parsedArray)) errors.push(`Expected array for ${ key }`);
          result[key] = parsedArray;
        }
        break;
      case 'object':
        {
          let parsedObject: unknown = value;
          if (typeof value === 'string') {
            try {
              parsedObject = JSON.parse(value);
            } catch {
              errors.push(`Invalid JSON object for ${ key }`);
            }
          }
          if (typeof parsedObject !== 'object' || parsedObject === null || Array.isArray(parsedObject)) {
            errors.push(`Expected object for ${ key }`);
          }
          result[key] = parsedObject;
        }
        break;
      }
    }

    if (errors.length) throw new Error(`Input validation failed:\n${ errors.join('\n') }`);

    return result;
  }

  protected get jsonSchema(): any {
    const properties: Record<string, any> = {};
    const required: string[] = [];

    for (const [key, spec] of Object.entries(this.schemaDef)) {
      const field: any = { description: spec.description || '' };

      switch (spec.type) {
      case 'string': field.type = 'string'; break;
      case 'number': field.type = 'number'; break;
      case 'boolean': field.type = 'boolean'; break;
      case 'enum':
        field.type = 'string';
        field.enum = spec.enum;
        break;
      case 'array':
        field.type = 'array';
        if (spec.items) field.items = this.fieldToJsonSchema(spec.items);
        break;
      case 'object':
        field.type = 'object';
        if (spec.properties) {
          field.properties = Object.fromEntries(
            Object.entries(spec.properties).map(([k, v]) => [k, this.fieldToJsonSchema(v)]),
          );
        }
        break;
      }

      if (spec.default !== undefined) field.default = spec.default;
      properties[key] = field;
      if (!spec.optional) required.push(key);
    }

    return {
      type:                 'object',
      properties,
      required,
      additionalProperties: false,
    };
  }

  private fieldToJsonSchema(spec: FieldSchema): any {
    const field: any = { type: spec.type === 'enum' ? 'string' : spec.type };
    if (spec.enum) field.enum = spec.enum;
    if (spec.description) field.description = spec.description;
    return field;
  }

  // LangChain / agent compatible shape (no inheritance needed)
  get lc_kwargs() {
    return {
      name:        this.name,
      description: this.description,
      parameters:  this.jsonSchema,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Execution entry point
  // ─────────────────────────────────────────────────────────────

  async call(rawInput: unknown): Promise<ToolResult> {
    const validated = this.parseInput(rawInput);
    try {
      const { successBoolean, responseString } = await this._validatedCall(validated);
      return {
        toolName: this.name,
        success:  successBoolean,
        result:   responseString,
      };
    } catch (error) {
      return {
        toolName: this.name,
        success:  false,
        error:    error instanceof Error ? error.message : String(error),
      };
    }
  }

  async invoke(input: unknown, state?: TState): Promise<ToolResult> {
    if (state) {
      this.setState(state);
    }
    return this.call(input);
  }

  protected abstract _validatedCall(input: ParsedInput): Promise<ToolResponse>;

  // ─────────────────────────────────────────────────────────────
  // Existing helpers
  // ─────────────────────────────────────────────────────────────

  public sendChatMessage?: (content: string, kind?: string) => Promise<boolean>;
  public emitProgress?:    (data: any) => Promise<void>;

  protected async emitMessage(content: string, kind = 'progress') {
    return this.sendChatMessage?.(content, kind) ?? false;
  }

  protected async emitProgressUpdate(data: any) {
    await this.emitProgress?.(data);
  }

  protected state: TState | null = null;
  setState(state: TState) { this.state = state }
}
