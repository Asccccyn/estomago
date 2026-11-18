import type { ToolCoverageProjection } from '../../capabilities/contracts.ts';
import { coverageRanges, projectCoveredText, type CoverageRange } from '../../memory-surfacing/window-coverage.ts';

type Row = Record<string, unknown>;

function record(value: unknown): Row[] {
  return value && typeof value === 'object' && !Array.isArray(value) ? [value as Row] : [];
}

export function memoryCoverageProjection(
  packet: Row,
  kind: 'recall' | 'detail',
  confirmed: readonly CoverageRange[],
  reread: boolean,
): ToolCoverageProjection {
  return pending => {
    const output = structuredClone(packet);
    const delivered: CoverageRange[] = [];
    const apply = (row: Row, fields: string[], fallback: CoverageRange[] = []) => {
      const field = fields.find(key => typeof row[key] === 'string' && row[key] !== '');
      const ranges = row.coverage_ranges === undefined ? fallback : coverageRanges(row.coverage_ranges);
      const offset = typeof row.coverage_text_offset === 'number' ? row.coverage_text_offset : undefined;
      delete row.coverage_ranges;
      delete row.coverage_text_offset;
      if (!field) return;
      const projected = projectCoveredText(row[field] as string, ranges, confirmed, [...pending, ...delivered], reread, offset);
      delivered.push(...projected.delivered);
      if (projected.status === 'full') return;
      delete row[field];
      if (projected.status === 'partial') row.unread_parts = projected.parts;
      else row[projected.status] = true;
    };

    if (kind === 'recall' && Array.isArray(output.candidates)) {
      for (const row of output.candidates.flatMap(record)) {
        const evidence = Array.isArray(row.evidence) ? row.evidence.flatMap(record) : [];
        if (typeof row.excerpt === 'string' && row.excerpt === evidence[0]?.snippet) {
          if (evidence[0].coverage_ranges === undefined) {
            evidence[0].coverage_ranges = row.coverage_ranges;
            evidence[0].coverage_text_offset = row.coverage_text_offset;
          }
          delete row.excerpt;
          delete row.coverage_ranges;
          delete row.coverage_text_offset;
        }
        apply(row, ['excerpt', 'text']);
        for (const item of evidence) apply(item, ['snippet']);
        for (const fragment of record(row.fragment)) apply(fragment, ['text']);
        const parts = [...evidence, ...record(row.fragment)];
        if (!row.text && !row.excerpt && !row.unread_parts && parts.length > 0
            && parts.every(item => item.already_in_window === true)) row.already_in_window = true;
      }
    }
    if (kind === 'detail') {
      const size = typeof output.text === 'string' ? [...output.text].length : 0;
      const extent = output.text_range;
      const start = Array.isArray(extent) && Number.isSafeInteger(extent[0]) ? Number(extent[0]) : 0;
      const fallback: CoverageRange[] = typeof output.memory_id === 'string' && output.version !== undefined && size > 0
        ? [{ resource_ref: `memory:${output.memory_id}`, content_version: String(output.version),
          start_char: start, end_char: start + size }] : [];
      apply(output, ['text'], fallback);
      for (const section of ['source', 'our_words']) {
        if (Array.isArray(output[section])) for (const row of output[section].flatMap(record)) apply(row, ['text']);
      }
    }
    return { output, coverageAdditions: delivered };
  };
}
