import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fullToolCatalog } from '../helpers.ts';
import { validateArgsAgainstSchema } from '../../apps/host/src/capabilities/validation.ts';

test('公开冻结 schema 使用的类型、组合、范围与码点长度生效且不修补参数', () => {
  const catalog = fullToolCatalog();
  for (const spec of catalog) validateArgsAgainstSchema({}, spec.function.parameters);
  const check = (name: string, args: Record<string, unknown>) =>
    validateArgsAgainstSchema(args, catalog.find(s => s.function.name === name)!.function.parameters);
  for (const [name, args, code] of [
    ['identity_milestone_write', { operation: 'write', confirm_overwrite: 'true' }, 'TOOL_ARG_TYPE'],
    ['identity_milestone_write', { text: 'x' }, 'TOOL_ARG_REQUIRED'],
    ['memory_correct', { action: 'relation', replacement: [] }, 'TOOL_ARG_TYPE'],
    ['memory_relations', { action: 'trace', memory_id:'synthetic', max_depth: 11 }, 'TOOL_ARG_LENGTH'],
    ['content_posts_list', { limit: '1' }, 'TOOL_ARG_TYPE'],
    ['memory_hold', { original_title: '😀'.repeat(31), categories:['daily'], text:'合成', creation_mode:'contemporaneous' }, 'TOOL_ARG_LENGTH'],
    ['memory_hold', { original_title:'合成', categories:['daily'], text:'合成', creation_mode:'contemporaneous', quotes: [{ seq: 1, invented: true }] }, 'TOOL_ARG_UNKNOWN'],
  ] as const) {
    const result = check(name, args);
    assert.equal(result.ok, false, name);
    if (!result.ok) assert.equal(result.code, code, JSON.stringify(result));
  }
  const args = { original_title: '😀'.repeat(30), categories: ['daily', 'sweet'], text: '原文  AbC\n正文', creation_mode: 'contemporaneous' };
  const copy = structuredClone(args);
  assert.equal(check('memory_hold', args).ok, true);
  assert.deepEqual(args, copy, 'no mutation, default filling or coercion');
  assert.equal(check('memory_recall', { query: '合成事件', date_from: '2026-11-01', date_to: '2026-11-04' }).ok, true);
});
