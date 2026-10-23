// Vendored from the oído-owned contract with source hashes; never rewrite stored receipts.
import { Ajv2020 } from 'ajv/dist/2020.js';
import contract from './contracts/model-projection.json' with { type: 'json' };
type Value = Record<string, unknown>;
type Shape = { $ref?: string; properties?: Record<string, Shape>; items?: Shape | boolean; prefixItems?: Shape[] };
const validator = new Ajv2020({ strict: false, strictNumbers: true });
validator.addSchema(contract.schema);
const kinds = ['analysis_ticket', 'evidence_overview', 'prosody_page'] as const;
const validators = Object.fromEntries(kinds.map(kind => [kind, validator.getSchema(`${contract.schema.$id}#/$defs/${kind}`)!]));

// Projection only: remove non-model fields, preserve exact values/array order.
// Complete semantic validation belongs to the standard Draft 2020-12 validator below.
function project(raw: unknown, spec: Shape): unknown {
  if (spec.$ref) spec = (contract.schema.$defs as Record<string, Shape>)[spec.$ref.split('/').at(-1)!];
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const value = raw as Value, out: Value = {};
    for (const [key, child] of Object.entries(spec.properties ?? {})) {
      if (value[key] !== undefined) out[key] = project(value[key], child);
    }
    return out;
  }
  if (Array.isArray(raw)) return raw.map((value, index) => project(value, spec.prefixItems?.[index] ?? (typeof spec.items === 'object' ? spec.items : {})));
  return raw;
}

export function oidoModelView(value: Value, page = false): Value {
  const kind = page ? 'prosody_page' : (value.state === 'queued' || value.state === 'running') ? 'analysis_ticket' : 'evidence_overview';
  const out = project(value, (contract.schema.$defs as Record<string, Shape>)[kind]) as Value;
  if (!validators[kind](out)) throw new Error('OIDO_RESULT_INVALID');
  if (Buffer.byteLength(JSON.stringify(out), 'utf8') > contract.budgets[kind]) throw new Error('OIDO_RESULT_BUDGET_EXCEEDED');
  return out;
}
