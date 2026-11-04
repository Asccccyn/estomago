import { Ajv, type AnySchema, type ErrorObject } from 'ajv';

// Frozen JSON Schema is the only argument contract. Ajv counts Unicode code points
// and must never repair a model call by coercing, defaulting or dropping fields.
const ajv = new Ajv({ strict: false, strictNumbers: true, allErrors: true,
  coerceTypes: false, useDefaults: false, removeAdditional: false });
export type SchemaShape = Record<string, unknown>;

export function validateArgsAgainstSchema(args: Record<string, unknown>, schema: SchemaShape):
  { ok: true; value: Record<string, unknown> } | { ok: false; code: string; detail: string } {
  const validate = ajv.compile(schema as AnySchema);
  if (validate(args)) return { ok: true, value: args };
  const errors = validate.errors!;
  // Report a useful branch error instead of the enclosing anyOf/if failure.
  const err = errors.find(e => !['anyOf', 'oneOf', 'if'].includes(e.keyword)) ?? errors[0]!;
  return { ok: false, code: errorCode(err), detail: `${err.instancePath || '/'} ${err.message ?? err.keyword} ${JSON.stringify(err.params)}` };
}

function errorCode(error: ErrorObject): string {
  switch (error.keyword) {
    case 'required': case 'dependencies': case 'dependentRequired': return 'TOOL_ARG_REQUIRED';
    case 'additionalProperties': return 'TOOL_ARG_UNKNOWN';
    case 'type': return 'TOOL_ARG_TYPE';
    case 'enum': case 'const': return 'TOOL_ARG_ENUM';
    case 'minLength': case 'maxLength': case 'minItems': case 'maxItems':
    case 'minimum': case 'maximum': case 'exclusiveMinimum': case 'exclusiveMaximum':
      return 'TOOL_ARG_LENGTH';
    default: return 'TOOL_ARG_TYPE';
  }
}
