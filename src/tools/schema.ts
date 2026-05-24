/*
 * File: schema.ts
 * Project: qwen-gate
 * JSON Schema draft-07 validator for tool calling.
 * Supports: type, properties, required, additionalProperties,
 *           items, enum, const, $ref, $defs, definitions,
 *           oneOf, anyOf, allOf, not, if/then/else,
 *           numeric constraints, string constraints, array constraints,
 *           nullable, default, patternProperties.
 */

import type { JsonSchema } from './types.ts';

/**
 * Error thrown when schema validation fails.
 */
export class SchemaValidationError extends Error {
  public readonly path: string;
  public readonly value: unknown;

  constructor(message: string, path: string, value?: unknown) {
    super(message);
    this.name = 'SchemaValidationError';
    this.path = path;
    this.value = value;
  }
}

/**
 * Validation context carries $defs/definitions for $ref resolution.
 */
interface ValidationContext {
  rootSchema: JsonSchema;
}

/**
 * Validates a value against a JSON Schema with strict type checking.
 * Throws SchemaValidationError on failure.
 * Returns the validated (possibly coerced) value on success.
 */
export function validateAgainstSchema(
  value: unknown,
  schema: JsonSchema,
  path: string = '$'
): unknown {
  const ctx: ValidationContext = { rootSchema: schema };
  return validate(value, schema, path, ctx);
}

function validate(
  value: unknown,
  schema: JsonSchema,
  path: string,
  ctx: ValidationContext
): unknown {
  // Boolean schemas (draft-07: true = accept all, false = reject all)
  if (typeof schema === 'boolean') {
    if (!schema) {
      throw new SchemaValidationError(`Schema is false — no value allowed at ${path}`, path, value);
    }
    return value;
  }

  // Empty schema accepts everything
  if (Object.keys(schema).length === 0) return value;

  // Handle nullable (OpenAI extension)
  if (schema.nullable && (value === null || value === undefined)) {
    return value;
  }

  // Handle $ref first — it replaces the entire schema
  if (schema.$ref) {
    const resolved = resolveRef(schema.$ref, ctx);
    return validate(value, resolved, path, ctx);
  }

  // Handle composition keywords
  if (schema.allOf) {
    value = validateAllOf(value, schema.allOf, path, ctx);
  }

  if (schema.anyOf) {
    value = validateAnyOf(value, schema.anyOf, path, ctx);
  }

  if (schema.oneOf) {
    value = validateOneOf(value, schema.oneOf, path, ctx);
  }

  if (schema.not) {
    validateNot(value, schema.not, path, ctx);
  }

  // Handle if/then/else (draft-07)
  if (schema.if) {
    value = validateIfThenElse(value, schema, path, ctx);
  }

  // Type-based validation
  const schemaType = schema.type;
  if (schemaType) {
    // Support type arrays like ["string", "null"]
    const types = Array.isArray(schemaType) ? schemaType : [schemaType];

    // Check if value matches any allowed type
    let matched = false;
    let lastError: SchemaValidationError | null = null;

    for (const t of types) {
      if (t === 'null' && value === null) { matched = true; break; }
      try {
        const result = validateByType(value, t, schema, path, ctx);
        value = result;
        matched = true;
        break;
      } catch (e) {
        if (e instanceof SchemaValidationError) lastError = e;
      }
    }

    if (!matched) {
      throw lastError || new SchemaValidationError(
        `Value at ${path} does not match any of types [${types.join(', ')}]`,
        path,
        value
      );
    }
  }

  // Enum validation (applies regardless of type)
  if (schema.enum !== undefined) {
    if (!schema.enum.some(e => deepEqual(e, value))) {
      throw new SchemaValidationError(
        `Value at ${path} is not one of [${schema.enum.map(e => JSON.stringify(e)).join(', ')}]`,
        path,
        value
      );
    }
  }

  // Const validation (draft-07)
  if (schema.const !== undefined) {
    if (!deepEqual(schema.const, value)) {
      throw new SchemaValidationError(
        `Value at ${path} does not match const ${JSON.stringify(schema.const)}`,
        path,
        value
      );
    }
  }

  return value;
}

function validateByType(
  value: unknown,
  type: string,
  schema: JsonSchema,
  path: string,
  ctx: ValidationContext
): unknown {
  switch (type) {
    case 'object':
      return validateObject(value, schema, path, ctx);
    case 'array':
      return validateArray(value, schema, path, ctx);
    case 'string':
      return validateString(value, schema, path);
    case 'number':
    case 'integer':
      return validateNumber(value, schema, path, type);
    case 'boolean':
      return validateBoolean(value, schema, path);
    case 'null':
      if (value !== null) {
        throw new SchemaValidationError(
          `Expected null at ${path}, got ${typeof value}`,
          path,
          value
        );
      }
      return null;
    default:
      return value;
  }
}

// ─── $ref Resolution ───────────────────────────────────────────────────────────

function resolveRef(ref: string, ctx: ValidationContext): JsonSchema {
  // Only support local refs: #/$defs/Foo or #/definitions/Foo
  if (!ref.startsWith('#/')) {
    throw new SchemaValidationError(
      `External $ref '${ref}' is not supported`,
      '$',
      ref
    );
  }

  const parts = ref.substring(2).split('/');
  let current: unknown = ctx.rootSchema;

  for (const part of parts) {
    // Decode JSON Pointer escapes
    const decoded = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (current && typeof current === 'object' && decoded in current) {
      current = (current as Record<string, unknown>)[decoded];
    } else {
      throw new SchemaValidationError(
        `$ref '${ref}' could not be resolved — '${decoded}' not found`,
        '$',
        ref
      );
    }
  }

  return current as JsonSchema;
}

// ─── Composition Keywords ──────────────────────────────────────────────────────

function validateAllOf(
  value: unknown,
  schemas: JsonSchema[],
  path: string,
  ctx: ValidationContext
): unknown {
  let result = value;
  for (let i = 0; i < schemas.length; i++) {
    result = validate(result, schemas[i], `${path}/allOf[${i}]`, ctx);
  }
  return result;
}

function validateAnyOf(
  value: unknown,
  schemas: JsonSchema[],
  path: string,
  ctx: ValidationContext
): unknown {
  const errors: string[] = [];
  for (let i = 0; i < schemas.length; i++) {
    try {
      return validate(value, schemas[i], path, ctx);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  throw new SchemaValidationError(
    `Value at ${path} does not match any of ${schemas.length} anyOf schemas: ${errors.join('; ')}`,
    path,
    value
  );
}

function validateOneOf(
  value: unknown,
  schemas: JsonSchema[],
  path: string,
  ctx: ValidationContext
): unknown {
  let matchCount = 0;
  let matchedValue: unknown = value;

  for (let i = 0; i < schemas.length; i++) {
    try {
      matchedValue = validate(value, schemas[i], path, ctx);
      matchCount++;
    } catch {
      // Expected for non-matching schemas
    }
  }

  if (matchCount === 0) {
    throw new SchemaValidationError(
      `Value at ${path} does not match any of ${schemas.length} oneOf schemas`,
      path,
      value
    );
  }

  if (matchCount > 1) {
    throw new SchemaValidationError(
      `Value at ${path} matches ${matchCount} oneOf schemas (must match exactly one)`,
      path,
      value
    );
  }

  return matchedValue;
}

function validateNot(
  value: unknown,
  schema: JsonSchema,
  path: string,
  ctx: ValidationContext
): void {
  try {
    validate(value, schema, path, ctx);
    // If it passes, the "not" constraint fails
    throw new SchemaValidationError(
      `Value at ${path} must NOT match the "not" schema`,
      path,
      value
    );
  } catch (e) {
    if (e instanceof SchemaValidationError && e.message.includes('must NOT match')) {
      throw e; // Re-throw our own error
    }
    // Validation against the not-schema failed, which is what we want
  }
}

function validateIfThenElse(
  value: unknown,
  schema: JsonSchema,
  path: string,
  ctx: ValidationContext
): unknown {
  let conditionMet = false;
  try {
    validate(value, schema.if!, path, ctx);
    conditionMet = true;
  } catch {
    conditionMet = false;
  }

  if (conditionMet && schema.then) {
    return validate(value, schema.then, path, ctx);
  }
  if (!conditionMet && schema.else) {
    return validate(value, schema.else, path, ctx);
  }

  return value;
}

// ─── Object Validation ─────────────────────────────────────────────────────────

function validateObject(
  value: unknown,
  schema: JsonSchema,
  path: string,
  ctx: ValidationContext
): Record<string, unknown> {
  if (value === null || value === undefined) {
    throw new SchemaValidationError(
      `Expected object at ${path}, got ${value === null ? 'null' : 'undefined'}`,
      path,
      value
    );
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new SchemaValidationError(
      `Expected object at ${path}, got ${typeof value}`,
      path,
      value
    );
  }

  const obj = value as Record<string, unknown>;
  const validated: Record<string, unknown> = {};

  // Check required properties
  if (schema.required) {
    for (const req of schema.required) {
      if (!(req in obj) || obj[req] === undefined) {
        throw new SchemaValidationError(
          `Missing required property '${req}' at ${path}`,
          `${path}.${req}`,
          undefined
        );
      }
    }
  }

  // minProperties / maxProperties
  const keys = Object.keys(obj);
  if (schema.minProperties !== undefined && keys.length < schema.minProperties) {
    throw new SchemaValidationError(
      `Object at ${path} has ${keys.length} properties, minimum is ${schema.minProperties}`,
      path,
      value
    );
  }
  if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) {
    throw new SchemaValidationError(
      `Object at ${path} has ${keys.length} properties, maximum is ${schema.maxProperties}`,
      path,
      value
    );
  }

  // Validate and collect properties
  const properties = schema.properties || {};
  const patternProperties = schema.patternProperties || {};
  const seenKeys = new Set<string>();

  for (const [key, val] of Object.entries(obj)) {
    seenKeys.add(key);
    const propSchema = properties[key];

    if (propSchema) {
      validated[key] = validate(val, propSchema, `${path}.${key}`, ctx);
    } else {
      // Check patternProperties
      let matchedPattern = false;
      for (const [pattern, patSchema] of Object.entries(patternProperties)) {
        if (new RegExp(pattern).test(key)) {
          validated[key] = validate(val, patSchema, `${path}.${key}`, ctx);
          matchedPattern = true;
        }
      }

      if (!matchedPattern) {
        if (schema.additionalProperties === false) {
          throw new SchemaValidationError(
            `Unexpected property '${key}' at ${path} (additionalProperties is false)`,
            `${path}.${key}`,
            val
          );
        } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
          validated[key] = validate(
            val,
            schema.additionalProperties as JsonSchema,
            `${path}.${key}`,
            ctx
          );
        } else {
          validated[key] = val;
        }
      }
    }
  }

  // Apply defaults for missing properties
  for (const [key, propSchema] of Object.entries(properties)) {
    if (!seenKeys.has(key) && (propSchema as JsonSchema).default !== undefined) {
      validated[key] = (propSchema as JsonSchema).default;
    }
  }

  return validated;
}

// ─── Array Validation ──────────────────────────────────────────────────────────

function validateArray(
  value: unknown,
  schema: JsonSchema,
  path: string,
  ctx: ValidationContext
): unknown[] {
  if (!Array.isArray(value)) {
    throw new SchemaValidationError(
      `Expected array at ${path}, got ${typeof value}`,
      path,
      value
    );
  }

  if (schema.minItems !== undefined && value.length < schema.minItems) {
    throw new SchemaValidationError(
      `Array at ${path} has ${value.length} items, minimum is ${schema.minItems}`,
      path,
      value
    );
  }

  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    throw new SchemaValidationError(
      `Array at ${path} has ${value.length} items, maximum is ${schema.maxItems}`,
      path,
      value
    );
  }

  if (schema.uniqueItems) {
    for (let i = 0; i < value.length; i++) {
      for (let j = i + 1; j < value.length; j++) {
        if (deepEqual(value[i], value[j])) {
          throw new SchemaValidationError(
            `Array at ${path} has duplicate items at indices ${i} and ${j} (uniqueItems is true)`,
            path,
            value
          );
        }
      }
    }
  }

  if (schema.items) {
    // items can be a single schema or an array of schemas (tuple validation)
    if (Array.isArray(schema.items)) {
      const itemsArray = schema.items as JsonSchema[];
      return value.map((item, i) => {
        const itemSchema = i < itemsArray.length
          ? itemsArray[i]
          : (schema.additionalProperties as JsonSchema | undefined);
        if (itemSchema) {
          return validate(item, itemSchema, `${path}[${i}]`, ctx);
        }
        return item;
      });
    }
    return value.map((item, i) =>
      validate(item, schema.items as JsonSchema, `${path}[${i}]`, ctx)
    );
  }

  return value;
}

// ─── String Validation ─────────────────────────────────────────────────────────

function validateString(
  value: unknown,
  schema: JsonSchema,
  path: string
): string {
  if (typeof value !== 'string') {
    throw new SchemaValidationError(
      `Expected string at ${path}, got ${typeof value}`,
      path,
      value
    );
  }

  if (schema.minLength !== undefined && value.length < schema.minLength) {
    throw new SchemaValidationError(
      `String at ${path} is ${value.length} chars, minimum is ${schema.minLength}`,
      path,
      value
    );
  }

  if (schema.maxLength !== undefined && value.length > schema.maxLength) {
    throw new SchemaValidationError(
      `String at ${path} is ${value.length} chars, maximum is ${schema.maxLength}`,
      path,
      value
    );
  }

  if (schema.pattern) {
    try {
      if (!new RegExp(schema.pattern).test(value)) {
        throw new SchemaValidationError(
          `String at ${path} does not match pattern '${schema.pattern}'`,
          path,
          value
        );
      }
    } catch (e) {
      if (e instanceof SchemaValidationError) throw e;
      // Invalid regex in schema — skip pattern validation
    }
  }

  if (schema.format) {
    // Basic format validation for common formats
    validateFormat(value, schema.format, path);
  }

  return value;
}

function validateFormat(value: string, format: string, path: string): void {
  switch (format) {
    case 'date-time':
      if (isNaN(Date.parse(value))) {
        throw new SchemaValidationError(
          `String at ${path} is not a valid date-time: '${value}'`,
          path,
          value
        );
      }
      break;
    case 'date':
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || isNaN(Date.parse(value))) {
        throw new SchemaValidationError(
          `String at ${path} is not a valid date: '${value}'`,
          path,
          value
        );
      }
      break;
    case 'email':
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        throw new SchemaValidationError(
          `String at ${path} is not a valid email: '${value}'`,
          path,
          value
        );
      }
      break;
    case 'uri':
    case 'url':
      try {
        new URL(value);
      } catch {
        throw new SchemaValidationError(
          `String at ${path} is not a valid URI: '${value}'`,
          path,
          value
        );
      }
      break;
    case 'uuid':
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
        throw new SchemaValidationError(
          `String at ${path} is not a valid UUID: '${value}'`,
          path,
          value
        );
      }
      break;
    // Other formats (hostname, ipv4, ipv6, etc.) — accept without strict validation
    // to avoid false positives with LLM-generated content
  }
}

// ─── Number Validation ─────────────────────────────────────────────────────────

function validateNumber(
  value: unknown,
  schema: JsonSchema,
  path: string,
  type: string
): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new SchemaValidationError(
      `Expected number at ${path}, got ${typeof value}`,
      path,
      value
    );
  }

  if (type === 'integer' && !Number.isInteger(value)) {
    throw new SchemaValidationError(
      `Expected integer at ${path}, got float ${value}`,
      path,
      value
    );
  }

  if (schema.minimum !== undefined && value < schema.minimum) {
    throw new SchemaValidationError(
      `Number ${value} at ${path} is below minimum ${schema.minimum}`,
      path,
      value
    );
  }

  if (schema.maximum !== undefined && value > schema.maximum) {
    throw new SchemaValidationError(
      `Number ${value} at ${path} is above maximum ${schema.maximum}`,
      path,
      value
    );
  }

  if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
    throw new SchemaValidationError(
      `Number ${value} at ${path} is not greater than exclusive minimum ${schema.exclusiveMinimum}`,
      path,
      value
    );
  }

  if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
    throw new SchemaValidationError(
      `Number ${value} at ${path} is not less than exclusive maximum ${schema.exclusiveMaximum}`,
      path,
      value
    );
  }

  if (schema.multipleOf !== undefined && schema.multipleOf > 0) {
    // Use modulo with floating point tolerance
    const remainder = value % schema.multipleOf;
    if (Math.abs(remainder) > 1e-10 && Math.abs(remainder - schema.multipleOf) > 1e-10) {
      throw new SchemaValidationError(
        `Number ${value} at ${path} is not a multiple of ${schema.multipleOf}`,
        path,
        value
      );
    }
  }

  return value;
}

// ─── Boolean Validation ────────────────────────────────────────────────────────

function validateBoolean(
  value: unknown,
  _schema: JsonSchema,
  path: string
): boolean {
  if (typeof value !== 'boolean') {
    throw new SchemaValidationError(
      `Expected boolean at ${path}, got ${typeof value}`,
      path,
      value
    );
  }
  return value;
}

// ─── Utility ───────────────────────────────────────────────────────────────────

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }

  if (typeof a === 'object' && typeof b === 'object') {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(key => key in bObj && deepEqual(aObj[key], bObj[key]));
  }

  return false;
}
