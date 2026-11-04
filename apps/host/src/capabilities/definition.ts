import type { HostToolSpec } from './contracts.ts';
import { sha256Hex } from '../util/id.ts';

export function definitionId(spec: HostToolSpec): string {
  return 'td_' + sha256Hex(JSON.stringify(spec)).slice(0, 24);
}

export function renderDefinition(spec: HostToolSpec): string {
  return `- ${spec.function.name}（definition_id: ${definitionId(spec)}）\n  description: ${spec.function.description}\n  parameters: ${JSON.stringify(spec.function.parameters)}`;
}
