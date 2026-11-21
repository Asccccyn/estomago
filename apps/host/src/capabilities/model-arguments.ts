import { isDeepStrictEqual } from 'node:util';
import type { HostToolSpec } from './contracts.ts';

// These suffixes appeared outside complete objects in native SDK calls.
const MODEL_ARGUMENT_SUFFIXES = new Map([
  ['content_album_entry_write', '}'],
  ['memory_recall', '</invoke>'],
]);

// The model-authored text consumed by each write path. IDs, enums, verbatim
// source selectors and artifact code are represented by their own contracts.
const PROSE_FIELDS = new Map<string, readonly string[]>([
  ['memory_hold', ['original_title', 'text', 'mood_tags', 'mood_note']],
  ['memory_update', ['original_title', 'text']],
  ['memory_open', ['text']],
  ['memory_correct', ['note', 'custom_label', 'replacement.custom_label', 'replacement.reverse_label']],
  ['memory_relations', ['custom_label']],
  ['memory_i_write', ['content', 'change_reason']],
  ['plans_write', ['title', 'content']],
  ['deletion_review', ['rejection_reason']],
  ['episode_apply', ['label', 'note']],
  ['wake_manage', ['note']],
  ['identity_milestone_write', ['text', 'change_reason']],
  ['conversation_archive', ['note']],
  ['content_post_create', ['title', 'body']],
  ['content_comment_create', ['body']],
  ['content_album_entry_write', ['caption', 'meaning']],
  ['wishstar_write_star', ['content', 'mood_type', 'mood_text', 'note']],
  ['wishstar_offer_star', ['message']],
  ['chat_send_text', ['text']],
  ['chat_send_attachment', ['content']],
  ['chat_send_voice', ['text', 'tts_script']],
  ['image_generate', ['prompt', 'title']],
]);

const LITERAL_HAN_GUIDE = '用中文撰写，中文直接填汉字。原文、专名和代码保留实际字符。';

export function describeLiteralHanFields(spec: HostToolSpec): HostToolSpec {
  const fields = PROSE_FIELDS.get(spec.function.name);
  const properties = spec.function.parameters.properties as Record<string, Record<string, unknown>> | undefined;
  if (!fields || !properties) return spec;
  let projected: typeof properties | undefined;
  const topFields = new Set(fields.map(path => path.split('.')[0]!));
  for (const field of topFields) {
    const property = properties[field];
    if (!property) continue;
    const description = typeof property.description === 'string' ? property.description : '';
    if (description.includes(LITERAL_HAN_GUIDE)) continue;
    const nestedFields = fields.filter(path => path.startsWith(field + '.')).map(path => path.split('.')[1]!);
    const guide = nestedFields.length > 0 ? nestedFields.join('、') + '：' + LITERAL_HAN_GUIDE : LITERAL_HAN_GUIDE;
    (projected ??= { ...properties })[field] = {
      ...property,
      description: [description, guide].filter(Boolean).join(' '),
    };
  }
  return projected ? { ...spec, function: { ...spec.function,
    parameters: { ...spec.function.parameters, properties: projected } } } : spec;
}

type SourceReviver = (this: object, key: string, value: unknown, context?: { source?: string }) => unknown;

export function decodeModelArguments(name: string, input: unknown, reviver?: SourceReviver): unknown {
  if (typeof input !== 'string') return input;
  const suffix = MODEL_ARGUMENT_SUFFIXES.get(name);
  if (!suffix && name !== 'memory_hold') return input;
  try {
    return JSON.parse(input, reviver);
  } catch {
    const trimmed = input.trimEnd();
    if (!suffix || !trimmed.endsWith(suffix)) return undefined;
    try {
      return JSON.parse(trimmed.slice(0, -suffix.length), reviver);
    } catch {
      return undefined;
    }
  }
}

const HAN = /\p{Script=Han}/u;
// Consume escaped backslashes as complete tokens; only a real JSON Unicode
// escape can encode a character. Match a surrogate pair before a single unit.
const JSON_ESCAPES = /\\(?:u(?:[dD][89aAbB][0-9a-fA-F]{2}\\u[dD][c-fC-F][0-9a-fA-F]{2}|[0-9a-fA-F]{4})|.)/gs;

function hasEscapedHan(source: string): boolean {
  for (const [escape] of source.matchAll(JSON_ESCAPES)) {
    if (escape.startsWith('\\u') && HAN.test(JSON.parse('"' + escape + '"'))) return true;
  }
  return false;
}

/** Require plain Han characters only for the current, provably matching
 * argument source. Code, references and literal reverse solidi stay intact. */
export function escapedHanArgumentField(
  name: string,
  args: Record<string, unknown>,
  source: string | undefined,
  viaInvoke: boolean,
): string | undefined {
  const fields = PROSE_FIELDS.get(name);
  if (!fields || !source?.includes('\\u')) return undefined;
  const escaped = new WeakMap<object, Set<string>>();
  const collect: SourceReviver = function (key, value, context) {
    if (typeof value === 'string' && context?.source && hasEscapedHan(context.source)) {
      const keys = escaped.get(this) ?? new Set<string>();
      keys.add(key);
      escaped.set(this, keys);
    }
    return value;
  };
  let value: unknown;
  try {
    const input = JSON.parse(source, collect);
    if (!viaInvoke) value = input;
    else if (input?.name === name) value = decodeModelArguments(name, input.arguments, collect);
  } catch {
    return undefined;
  }
  if (!isDeepStrictEqual(value, args)) return undefined;
  const object = value as Record<string, unknown>;
  return fields.find(path => {
    const [head, nested] = path.split('.');
    if (!head) return false;
    const parent = nested === undefined ? object : object[head];
    if (!parent || typeof parent !== 'object' || Array.isArray(parent)) return false;
    const field = nested ?? head;
    const child = (parent as Record<string, unknown>)[field];
    return escaped.get(parent)?.has(field) || (Array.isArray(child) && escaped.has(child));
  });
}
