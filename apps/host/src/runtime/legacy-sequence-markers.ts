import type { HostToolSpec } from '../capabilities/contracts.ts';

export function catalogUsesLegacySequenceMarkers(catalog: readonly HostToolSpec[]): boolean {
  const read = catalog.find(spec => spec.function.name === 'conversation_read');
  const properties = read?.function.parameters.properties;
  return typeof properties === 'object' && properties !== null && ('around_seq' in properties || 'from_sequence' in properties);
}

export function stripLegacySequenceMarker(text: string): string {
  return text.replace(/^(\[seq ?\d+\]|\[\d+\])\s*/, '');
}
